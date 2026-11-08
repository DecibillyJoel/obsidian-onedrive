/**
 * Sync manager
 * Tracks dirty files from vault events and triggers debounced sync.
 * Uses deterministic suppression (not timing) to avoid reacting to
 * our own writes or Obsidian's startup file indexing.
 */

import { App, TFile, TFolder, EventRef, Events } from 'obsidian';
import { LocalChange, LocalChangeType } from '../types';
import { SyncStateManager } from './syncState';
import { logger } from '../utils/logger';
import { SYNC_CONFIG } from '../constants';
import { shouldSyncVaultPath } from '../utils/pathUtils';

import { timerApi } from '../utils/timerApi';

/**
 * Manages vault event listeners and sync scheduling
 */
export class EventManager {
	private eventRefs: EventRef[] = [];
	private throttleTimer?: number;
	private syncTimer?: number;
	private isSyncing = false;
	// Set when a vault change arrives while a sync is running, so a follow-up
	// sync gets scheduled once the current one finishes (instead of the change
	// sitting in the dirty queue until the next unrelated trigger).
	private syncRequestedDuringSync = false;
	// Dirty entries are keyed by queue slot (e.g. `path:notes/a.md`,
	// `rename:notes/a.md`) so a rename owns its own slot instead of
	// colliding with the new path. Each entry carries the revision at which
	// it was queued.
	private dirtyFiles: Map<string, { change: LocalChange; revision: number }> = new Map();
	// Monotonic queue revision. A sync acknowledges only entries at or below
	// the revision it snapshotted, so an event arriving while I/O is in flight
	// can never be erased by end-of-sync cleanup.
	private dirtyRevision = 0;
	// Paths we wrote during sync — events for these are our own writes, not user edits
	private ownWritePaths: Set<string> = new Set();
	// Suppress raw config events until after the first sync completes,
	// because Obsidian rewrites config files on startup (new mtime, same content).
	private initialSyncDone = false;
	// When false, vault change events mark files dirty but do not schedule auto-sync
	private syncOnFileChange = true;
	// Quiet period after the last vault change before an auto-sync fires
	private fileChangeSyncDelayMs: number = SYNC_CONFIG.EVENT_THROTTLE_MS;
	// Callback to check if pull-only mode is enabled
	private isPullOnlyMode: () => boolean = () => false;

	/**
	 * @param app - The Obsidian App instance.
	 * @param onSyncTriggered - Callback invoked when a debounced sync fires.
	 * @param stateManager - Sync state manager for tracking file state.
	 * @param shouldSyncPath - Predicate that decides whether a given vault path participates in sync.
	 * @param syncOnFileChange - Whether vault-change events should trigger a debounced auto-sync.
	 *   **Pass the persisted setting here** so the EventManager is correctly configured from the
	 *   moment it is constructed, before `startListening()` is ever called.  Defaulting to `true`
	 *   preserves backward-compatible behaviour for callers that don't pass the argument (e.g. the
	 *   DEV-only `createTestConflict` path that never calls `startListening`).
	 * @param fileChangeSyncDelayMs - Quiet period after the last vault change before an auto-sync
	 *   fires. Pass the persisted setting, for the same reason as `syncOnFileChange`.
	 */
	constructor(
		private app: App,
		private onSyncTriggered: () => Promise<void>,
		private stateManager: SyncStateManager,
		private shouldSyncPath: (path: string) => boolean = (path) => shouldSyncVaultPath(path, false, false, app.vault.configDir),
		syncOnFileChange = true,
		fileChangeSyncDelayMs: number = SYNC_CONFIG.EVENT_THROTTLE_MS
	) {
		this.syncOnFileChange = syncOnFileChange;
		this.fileChangeSyncDelayMs = fileChangeSyncDelayMs;
	}

	/**
	 * Set the callback to check if pull-only mode is enabled.
	 * In pull-only mode, local file changes are ignored (not queued for upload).
	 */
	setPullOnlyModeCheck(isPullOnlyMode: () => boolean): void {
		this.isPullOnlyMode = isPullOnlyMode;
	}

	private shouldIgnoreEvent(path: string): boolean {
		if (!this.shouldSyncPath(path)) return true;

		// In pull-only mode, ignore all local changes (don't queue for upload)
		if (this.isPullOnlyMode()) {
			logger.debug(`Pull-only mode: ignoring local change for: ${path}`);
			return true;
		}

		// If we wrote this path during sync, ignore the resulting event
		if (this.ownWritePaths.has(path)) {
			this.ownWritePaths.delete(path);
			logger.debug(`Ignoring own-write event for: ${path}`);
			return true;
		}

		return false;
	}

	/**
	 * Mark paths as written by us (so we ignore the resulting vault events)
	 */
	markOwnWrites(paths: string[]): void {
		for (const path of paths) {
			this.ownWritePaths.add(path);
		}
	}

	/**
	 * Remove a path from own-write suppression (e.g., if write failed)
	 */
	removeOwnWrite(path: string): void {
		this.ownWritePaths.delete(path);
	}

	/**
	 * Check if a path is currently suppressed as an own-write.
	 */
	isOwnWrite(path: string): boolean {
		return this.ownWritePaths.has(path);
	}

	/**
	 * Signal that the first sync after plugin load has completed.
	 * Raw config-file events are suppressed until this is called,
	 * because Obsidian rewrites config files on startup.
	 */
	markInitialSyncDone(): void {
		this.initialSyncDone = true;
	}

	/**
	 * Enable or disable automatic sync scheduling when files change.
	 * When disabled, vault events still track dirty files but do not
	 * trigger a debounced sync — only periodic and manual syncs run.
	 */
	setSyncOnFileChange(enabled: boolean): void {
		this.syncOnFileChange = enabled;
	}

	/**
	 * Set how long vault changes must stay quiet before an auto-sync fires.
	 * Each new change restarts the wait, so continuous editing is batched
	 * into one sync once the user pauses for this long.
	 */
	setFileChangeSyncDelay(delayMs: number): void {
		this.fileChangeSyncDelayMs = delayMs;
	}

	/**
	 * Get dirty files without clearing them.
	 * Call clearDirtyFiles() after successful sync.
	 */
	getDirtyFiles(): LocalChange[] {
		return Array.from(this.dirtyFiles.values(), (entry) => entry.change);
	}

	/** Capture a stable acknowledgement boundary for one sync attempt. */
	getDirtySnapshot(): { changes: LocalChange[]; revision: number } {
		return { changes: this.getDirtyFiles(), revision: this.dirtyRevision };
	}

	/**
	 * Acknowledge work from a previously captured snapshot. Entries replaced
	 * or added after the snapshot have a newer revision and remain queued.
	 * When paths are supplied, only completed paths are acknowledged.
	 */
	acknowledgeDirtySnapshot(revision: number, paths?: string[]): void {
		const completedPaths = paths ? new Set(paths) : undefined;
		for (const [key, entry] of this.dirtyFiles) {
			if (entry.revision > revision) continue;
			if (completedPaths && !completedPaths.has(entry.change.path)) continue;
			this.dirtyFiles.delete(key);
		}
	}

	/**
	 * Clear all dirty files (call after successful sync)
	 */
	clearDirtyFiles(): void {
		this.dirtyFiles.clear();
	}

	/**
	 * Remove specific paths from the dirty set (e.g., files we just downloaded)
	 */
	removeDirtyPaths(paths: string[]): void {
		const removedPaths = new Set(paths);
		for (const [key, entry] of this.dirtyFiles) {
			if (removedPaths.has(entry.change.path)) {
				this.dirtyFiles.delete(key);
			}
		}
	}

	/**
	 * Manually add a dirty file (e.g., after conflict resolution)
	 */
	addDirtyFile(path: string, type: 'modify' | 'create'): void {
		const changeType = type === 'create' ? LocalChangeType.CREATE : LocalChangeType.MODIFY;
		this.queueChange({ path, type: changeType });
	}

	/** Queue a change under its queue slot, stamping the current revision. */
	queueChange(change: LocalChange, key: string = `path:${change.path}`): void {
		this.dirtyFiles.set(key, { change, revision: ++this.dirtyRevision });
	}

	deleteQueuedPath(path: string): void {
		this.dirtyFiles.delete(`path:${path}`);
	}

	getQueuedPath(path: string): LocalChange | undefined {
		return this.dirtyFiles.get(`path:${path}`)?.change;
	}

	/**
	 * Put changes that failed to apply back on the dirty queue so the next
	 * sync retries them. A newer event already queued for the same path wins,
	 * since it reflects the vault's current state.
	 */
	requeueChanges(changes: LocalChange[]): void {
		for (const change of changes) {
			if (!this.getQueuedPath(change.path)) {
				this.queueChange(change);
			}
		}
	}

	/**
	 * Start listening to vault events
	 */
	startListening(): void {
		logger.info('Starting vault event listeners');

		this.eventRefs.push(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					this.queueChange({ path: file.path, type: LocalChangeType.MODIFY });
					this.scheduleSync();
				}
			})
		);

		this.eventRefs.push(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					// A file deleted and recreated before the sync drained its DELETE
					// is an edit, not a new file — queue the type the vault now holds.
					const previous = this.getQueuedPath(file.path);
					if (previous?.type === LocalChangeType.DELETE) {
						this.queueChange({
							path: file.path,
							type: this.stateManager.getFileState(file.path)
								? LocalChangeType.MODIFY
								: LocalChangeType.CREATE,
						});
						this.scheduleSync();
						return;
					}
					// If file is already tracked in sync state, this is Obsidian
					// re-indexing on startup — not a real new file.
					//
					// NOTE: This guard is only reliable for *subsequent* syncs where
					// state has already been persisted.  On the very first sync no
					// file is tracked yet, so startup CREATE events for files that
					// already exist in OneDrive will still be queued here.
					// planOperations() compensates: when isFirstSync is true it
					// ignores CREATE dirty entries whose path appears as a live
					// (non-deleted) item in the remote delta.
					if (this.stateManager.getFileState(file.path)) {
						return;
					}
					this.queueChange({ path: file.path, type: LocalChangeType.CREATE });
					this.scheduleSync();
				} else if (file instanceof TFolder && !this.shouldIgnoreEvent(file.path)) {
					// Suppress folder creates until initial sync completes —
					// Obsidian fires create events for all existing folders on startup
					if (!this.initialSyncDone) return;
					if (this.stateManager.getFolderIdByPath(file.path)) return;
					this.queueChange({ path: file.path, type: LocalChangeType.FOLDER_CREATE });
					this.scheduleSync();
				}
			})
		);

		this.eventRefs.push(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					this.queueChange({ path: file.path, type: LocalChangeType.DELETE });
					this.scheduleSync();
				} else if (file instanceof TFolder && !this.shouldIgnoreEvent(file.path)) {
					this.queueChange({ path: file.path, type: LocalChangeType.FOLDER_DELETE });
					this.scheduleSync();
				}
			})
		);

		this.eventRefs.push(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					logger.debug(`Vault rename event: ${oldPath} → ${file.path}`);
					// A rename of a file we still believe is new is just the user
					// naming it — queue a CREATE at the new path (the OneDrive item
					// does not exist yet, so a RENAME would look up a missing id).
					const sourceChange = this.getQueuedPath(oldPath);
					this.deleteQueuedPath(oldPath);
					if (sourceChange?.type === LocalChangeType.CREATE) {
						this.queueChange({ path: file.path, type: LocalChangeType.CREATE });
					} else {
						this.queueChange(
							{ path: file.path, type: LocalChangeType.RENAME, oldPath },
							`rename:${oldPath}`
						);
					}
					this.scheduleSync();
				} else if (file instanceof TFolder && !this.shouldIgnoreEvent(file.path)) {
					logger.debug(`Vault folder rename event: ${oldPath} → ${file.path}`);
					if (this.getQueuedPath(oldPath)) {
						this.deleteQueuedPath(oldPath);
					}
					// Check if this is a rename of an existing tracked folder vs a new folder
					const folderId = this.stateManager.getFolderIdByPath(oldPath);
					if (folderId) {
						// This is a rename of an existing synced folder — use FOLDER_RENAME
						this.queueChange(
							{
								path: file.path,
								type: LocalChangeType.FOLDER_RENAME,
								oldPath,
							},
							`rename:${oldPath}`
						);
					} else {
						// New folder being renamed (e.g., "Untitled" → real name) — treat as create
						this.queueChange({ path: file.path, type: LocalChangeType.FOLDER_CREATE });
					}
					this.scheduleSync();
				}
			})
		);

		// The typed vault events above only fire for TFile instances —
		// config files inside .obsidian/ are not TFiles. The undocumented
		// 'raw' event fires for ALL file changes on disk and gives us the
		// path string. Use it to detect config-file changes (e.g. plugin
		// enable/disable modifying community-plugins.json).
		const configPrefix = `${this.app.vault.configDir}/`;
		this.eventRefs.push(
			(this.app.vault as Events).on('raw', (...args: unknown[]) => {
				const path = args[0];
				if (typeof path !== 'string') return;
				if (!path.startsWith(configPrefix)) return;
				if (!this.shouldSyncPath(path)) return;
				if (this.shouldIgnoreEvent(path)) return;
				// Ignore raw events until the first sync completes — Obsidian
				// rewrites config files on startup with new mtimes.
				if (!this.initialSyncDone) return;
				// Already queued by a typed event — skip
				if (this.getQueuedPath(path)) return;

				// Compare mtime/size against tracked state to avoid false
				// positives from Obsidian touching config files on startup.
				const tracked = this.stateManager.getFileState(path);
				void this.app.vault.adapter.stat(path).then((stat) => {
					if (this.getQueuedPath(path)) return; // raced with another event

					if (!stat || stat.type !== 'file') {
						// File no longer exists — if we were tracking it, it's a delete
						if (tracked) {
							this.queueChange({ path, type: LocalChangeType.DELETE });
							logger.debug(`Raw event: config file deleted: ${path}`);
							this.scheduleSync();
						}
						return;
					}

					if (tracked && stat.mtime === tracked.localMtime && stat.size === tracked.size) {
						return; // unchanged — ignore
					}
					const type = tracked ? LocalChangeType.MODIFY : LocalChangeType.CREATE;
					this.queueChange({ path, type });
					logger.debug(`Raw event: config file changed: ${path}`);
					this.scheduleSync();
				});
			})
		);

		logger.info('Event listeners registered');
	}

	/**
	 * Schedule a debounced sync (trailing edge)
	 */
	private scheduleSync(): void {
		if (!this.syncOnFileChange) return;
		if (this.isSyncing) {
			this.syncRequestedDuringSync = true;
			return;
		}

		if (this.throttleTimer !== undefined) {
			timerApi.clearTimeout(this.throttleTimer);
		}

		this.throttleTimer = timerApi.setTimeout(() => {
			void this.executeSync();
		}, this.fileChangeSyncDelayMs);
	}

	/**
	 * Start periodic sync at the given interval (minutes). 0 = disabled.
	 */
	startPeriodicSync(intervalMinutes: number): void {
		this.stopPeriodicSync();

		if (intervalMinutes <= 0) {
			logger.info('Periodic sync disabled');
			return;
		}

		const intervalMs = intervalMinutes * 60 * 1000;
		logger.info(`Starting periodic sync every ${intervalMinutes} minutes`);

		this.syncTimer = timerApi.setInterval(() => {
			if (!this.isSyncing) {
				void this.executeSync();
			}
		}, intervalMs);
	}

	/**
	 * Stop periodic sync
	 */
	stopPeriodicSync(): void {
		if (this.syncTimer !== undefined) {
			timerApi.clearInterval(this.syncTimer);
			this.syncTimer = undefined;
		}
	}

	/**
	 * Stop listening to vault events and periodic sync
	 */
	stopListening(): void {
		logger.info('Stopping event listeners');

		this.stopPeriodicSync();

		if (this.throttleTimer !== undefined) {
			timerApi.clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}

		this.eventRefs.forEach((ref) => {
			this.app.vault.offref(ref);
		});
		this.eventRefs = [];

		logger.info('Event listeners stopped');
	}

	/**
	 * Execute sync operation
	 */
	private async executeSync(): Promise<void> {
		this.isSyncing = true;

		try {
			await this.onSyncTriggered();
		} catch (error) {
			logger.error('Error during sync:', error);
		} finally {
			this.isSyncing = false;
			// Changes that arrived mid-sync couldn't schedule — do it now so
			// they don't wait for the next unrelated trigger. Only vault-event
			// callers set the flag, so failed operations re-queued by the sync
			// engine can't create a retry loop here.
			if (this.syncRequestedDuringSync) {
				this.syncRequestedDuringSync = false;
				this.scheduleSync();
			}
		}
	}

	/**
	 * Trigger immediate sync (manual or startup)
	 */
	async triggerManualSync(): Promise<void> {
		logger.info('Manual sync triggered');

		if (this.isSyncing) {
			logger.debug('Sync already in progress, skipping');
			return;
		}

		await this.executeSync();
	}

	/**
	 * Check if sync is currently in progress
	 */
	isSyncInProgress(): boolean {
		return this.isSyncing;
	}
}
