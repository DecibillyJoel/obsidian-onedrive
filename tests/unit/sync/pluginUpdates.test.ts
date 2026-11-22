import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setDebugMode: vi.fn(),
		enableFileLogging: vi.fn(),
		setVaultLogHook: vi.fn(),
	},
}));

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
	return { ...actual };
});

import { TFile } from 'obsidian';
import '../../setup';
import { mockApp, makeTFile } from '../../setup';
import { SyncEngine } from '../../../src/sync/syncEngine';
import { logger } from '../../../src/utils/logger';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import { ConflictResolutionStrategy, OneDriveItem } from '../../../src/types';
import { shouldSyncVaultPath } from '../../../src/utils/pathUtils';

const CONFIG_DIR = '.obsidian';
const PLUGINS_DIR = `${CONFIG_DIR}/plugins`;
const OWN_FOLDER = `${PLUGINS_DIR}/onedrive-sync`;
const REMOTE_ROOT = '/remote/root';

function makeRemoteFile(
	vaultPath: string,
	overrides: Partial<OneDriveItem> & { id?: string; name?: string } = {}
): OneDriveItem {
	const parts = vaultPath.split('/');
	const name = overrides.name ?? parts.pop() ?? vaultPath;
	const parent = parts.join('/');

	return {
		id: overrides.id ?? `${vaultPath}-id`,
		name,
		size: overrides.size ?? 100,
		lastModifiedDateTime:
			overrides.lastModifiedDateTime ?? new Date('2026-01-01T00:00:00.000Z').toISOString(),
		file: overrides.file ?? {
			mimeType: 'application/javascript',
			hashes: { quickXorHash: `${vaultPath}-hash` },
		},
		parentReference: overrides.parentReference ?? {
			id: 'parent-id',
			path: `/drive/root:${REMOTE_ROOT}/${parent}`,
		},
		...overrides,
	} as OneDriveItem;
}

function makeRemoteFolder(vaultPath: string, overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	const parts = vaultPath.split('/');
	const name = overrides.name ?? parts.pop() ?? vaultPath;
	const parent = parts.join('/');

	return {
		id: overrides.id ?? `${vaultPath}-id`,
		name,
		folder: { childCount: 1 },
		parentReference: overrides.parentReference ?? {
			id: 'parent-id',
			path: `/drive/root:${REMOTE_ROOT}/${parent}`,
		},
		...overrides,
	} as OneDriveItem;
}

function manifestContent(version: string): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify({ id: 'onedrive-sync', version })).buffer;
}

describe('SyncEngine.pullPluginUpdates', () => {
	let syncEngine: SyncEngine;
	let stateManager: SyncStateManager;
	let mockFileOps: {
		uploadFile: Mock;
		downloadFile: Mock;
		deleteFile: Mock;
		moveFile: Mock;
		createFolder: Mock;
	};
	let mockClient: {
		listAllItems: Mock;
		getDelta: Mock;
		isSharedDrive: Mock;
	};
	let mockEventManager: {
		getDirtyFiles: Mock;
		clearDirtyFiles: Mock;
		removeDirtyPaths: Mock;
		addDirtyFile: Mock;
		markOwnWrites: Mock;
		removeOwnWrite: Mock;
		isOwnWrite: Mock;
		markInitialSyncDone: Mock;
		requeueChanges: Mock;
	};

	function buildEngine(
		pluginVersion: string = '2.1.1',
		shouldSyncPath?: (path: string) => boolean
	): SyncEngine {
		return new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS),
			mockEventManager as any,
			CONFIG_DIR,
			{
				remoteRoot: REMOTE_ROOT,
				pluginVersion,
				// Mirror the production wiring in main.ts, where plugin manifests,
				// data and binaries are in scope.
				shouldSyncPath:
					shouldSyncPath ??
					((path) => shouldSyncVaultPath(path, true, true, CONFIG_DIR, true, true, true)),
			}
		);
	}

	beforeEach(() => {
		mockApp.vault.getAbstractFileByPath.mockReset().mockReturnValue(null);
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.read.mockReset().mockRejectedValue(new Error('missing .syncIgnore'));
		mockApp.vault.adapter.mkdir.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.stat.mockReset().mockResolvedValue(null);
		mockApp.vault.adapter.list.mockReset().mockResolvedValue({ files: [], folders: [] });

		mockFileOps = {
			uploadFile: vi.fn(),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn(),
			moveFile: vi.fn(),
			createFolder: vi.fn(),
		};

		mockClient = {
			listAllItems: vi.fn().mockResolvedValue([]),
			getDelta: vi.fn(),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};

		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			removeDirtyPaths: vi.fn(),
			addDirtyFile: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
			requeueChanges: vi.fn(),
		};

		stateManager = new SyncStateManager();
		syncEngine = buildEngine();
	});

	it('downloads a plugin file that has no local copy and creates its folder', async () => {
		const folderPath = `${PLUGINS_DIR}/newplugin`;
		const filePath = `${folderPath}/main.js`;
		const created = new Set<string>();

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFolder(folderPath),
			makeRemoteFile(filePath, { id: 'main-js-id', size: 100 }),
		]);
		mockApp.vault.adapter.exists.mockImplementation(
			async (path: string) => path !== folderPath || created.has(path)
		);
		mockApp.vault.adapter.mkdir.mockImplementation(async (path: string) => {
			created.add(path);
		});

		const result = await syncEngine.pullPluginUpdates();

		expect(mockClient.listAllItems).toHaveBeenCalledWith(REMOTE_ROOT);
		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('main-js-id');
		expect(mockApp.vault.adapter.mkdir).toHaveBeenCalledWith(folderPath);
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(filePath, expect.any(ArrayBuffer));
		expect(result.downloadedPaths).toEqual([filePath]);
		expect(result.updated).toEqual(['newplugin']);
		expect(result.skippedOwnFolder).toBe(false);
	});

	it('skips a plugin file whose local size and mtime match the remote item', async () => {
		const filePath = `${PLUGINS_DIR}/alpha/main.js`;
		const mtime = new Date('2026-01-01T00:00:00.000Z').getTime();

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(filePath, { size: 100, lastModifiedDateTime: new Date(mtime).toISOString() }),
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile(filePath, 100, mtime));

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(result.updated).toEqual([]);
	});

	it('downloads a plugin file whose size differs from the local file', async () => {
		const filePath = `${PLUGINS_DIR}/alpha/main.js`;
		const mtime = new Date('2026-01-01T00:00:00.000Z').getTime();

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(filePath, {
				id: 'alpha-main-id',
				size: 100,
				lastModifiedDateTime: new Date(mtime).toISOString(),
			}),
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile(filePath, 50, mtime));

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('alpha-main-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(filePath, expect.any(ArrayBuffer));
		expect(result.downloadedPaths).toEqual([filePath]);
		expect(result.updated).toEqual(['alpha']);
	});

	it('downloads a plugin file whose remote mtime is newer despite matching size', async () => {
		const filePath = `${PLUGINS_DIR}/alpha/main.js`;
		const localMtime = new Date('2026-01-01T00:00:00.000Z').getTime();
		const remoteMtime = new Date('2026-02-01T00:00:00.000Z').getTime();

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(filePath, {
				id: 'alpha-main-id',
				size: 100,
				lastModifiedDateTime: new Date(remoteMtime).toISOString(),
			}),
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile(filePath, 100, localMtime));

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('alpha-main-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(filePath, expect.any(ArrayBuffer));
		expect(result.updated).toEqual(['alpha']);
	});

	it('skips the own plugin folder when the remote manifest version is not newer', async () => {
		const manifestPath = `${OWN_FOLDER}/manifest.json`;
		const mainPath = `${OWN_FOLDER}/main.js`;
		const dataPath = `${OWN_FOLDER}/data.json`;

		mockFileOps.downloadFile.mockResolvedValue(manifestContent('2.1.1'));
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(manifestPath, { id: 'own-manifest-id' }),
			makeRemoteFile(mainPath, { id: 'own-main-id' }),
			makeRemoteFile(dataPath, { id: 'own-data-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('own-manifest-id');
		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(result.updated).toEqual([]);
		expect(result.skippedOwnFolder).toBe(true);
	});

	it('writes the own plugin folder when the remote manifest version is newer, except data.json', async () => {
		const manifestPath = `${OWN_FOLDER}/manifest.json`;
		const mainPath = `${OWN_FOLDER}/main.js`;
		const dataPath = `${OWN_FOLDER}/data.json`;

		mockFileOps.downloadFile.mockImplementation(async (id: string) =>
			id === 'own-manifest-id' ? manifestContent('2.2.0') : new ArrayBuffer(10)
		);
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(manifestPath, { id: 'own-manifest-id' }),
			makeRemoteFile(mainPath, { id: 'own-main-id' }),
			makeRemoteFile(dataPath, { id: 'own-data-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		const writtenPaths = mockApp.vault.adapter.writeBinary.mock.calls.map((call) => call[0]);
		expect(writtenPaths).toContain(manifestPath);
		expect(writtenPaths).toContain(mainPath);
		expect(writtenPaths).not.toContain(dataPath);
		expect(mockFileOps.downloadFile).not.toHaveBeenCalledWith('own-data-id');
		expect(result.skippedOwnFolder).toBe(false);
		expect(result.updated).toEqual(['onedrive-sync']);
	});

	it('skips the own plugin folder when the running version is unknown', async () => {
		syncEngine = buildEngine('unknown');
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(`${OWN_FOLDER}/manifest.json`, { id: 'own-manifest-id' }),
			makeRemoteFile(`${OWN_FOLDER}/main.js`, { id: 'own-main-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(result.skippedOwnFolder).toBe(true);
	});

	it('does not clear file states or advance the delta cursor', async () => {
		const filePath = `${PLUGINS_DIR}/alpha/main.js`;
		stateManager.setDeltaLink('previous-delta-link');
		stateManager.setFileState('notes/a.md', {
			path: 'notes/a.md',
			localMtime: 1,
			remoteHash: 'hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'notes-a-id',
		});

		mockClient.listAllItems.mockResolvedValue([makeRemoteFile(filePath, { id: 'alpha-main-id' })]);

		await syncEngine.pullPluginUpdates();

		expect(stateManager.getDeltaLink()).toBe('previous-delta-link');
		expect(stateManager.getFileState('notes/a.md')).toBeDefined();
		expect(mockClient.getDelta).not.toHaveBeenCalled();
	});

	it('lists each updated plugin id only once', async () => {
		const folder = `${PLUGINS_DIR}/beta`;

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(`${folder}/main.js`, { id: 'beta-main-id' }),
			makeRemoteFile(`${folder}/styles.css`, { id: 'beta-css-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledTimes(2);
		expect(result.downloadedPaths).toEqual([`${folder}/main.js`, `${folder}/styles.css`]);
		expect(result.updated).toEqual(['beta']);
	});

	it('decides with adapter.stat when the vault index has no entry', async () => {
		const changedPath = `${PLUGINS_DIR}/gamma/main.js`;
		const matchingPath = `${PLUGINS_DIR}/gamma/styles.css`;
		const mtime = new Date('2026-01-01T00:00:00.000Z').getTime();
		const localStats: Record<string, { size: number; mtime: number; ctime: number }> = {
			[changedPath]: { size: 40, mtime, ctime: mtime },
			[matchingPath]: { size: 100, mtime, ctime: mtime },
		};

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(changedPath, {
				id: 'gamma-main-id',
				size: 100,
				lastModifiedDateTime: new Date(mtime).toISOString(),
			}),
			makeRemoteFile(matchingPath, {
				id: 'gamma-css-id',
				size: 100,
				lastModifiedDateTime: new Date(mtime).toISOString(),
			}),
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) => localStats[path] ?? null);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalledWith(changedPath);
		expect(mockApp.vault.adapter.stat).toHaveBeenCalledWith(changedPath);
		expect(mockApp.vault.adapter.stat).toHaveBeenCalledWith(matchingPath);
		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('gamma-main-id');
		expect(mockFileOps.downloadFile).not.toHaveBeenCalledWith('gamma-css-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
			changedPath,
			expect.any(ArrayBuffer)
		);
		expect(result.downloadedPaths).toEqual([changedPath]);
	});

	it('continues with the remaining files when one download fails', async () => {
		const failedPath = `${PLUGINS_DIR}/broken/main.js`;
		const goodPath = `${PLUGINS_DIR}/working/main.js`;

		mockFileOps.downloadFile.mockImplementation(async (id: string) => {
			if (id === 'broken-main-id') {
				throw new Error('download failed');
			}
			return new ArrayBuffer(10);
		});
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(failedPath, { id: 'broken-main-id' }),
			makeRemoteFile(goodPath, { id: 'working-main-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(result.downloadedPaths).toEqual([goodPath]);
		expect(result.downloadedPaths).not.toContain(failedPath);
		expect(result.updated).toEqual(['working']);
		expect(result.updated).not.toContain('broken');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
			goodPath,
			expect.any(ArrayBuffer)
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(failedPath),
			expect.any(Error)
		);
	});

	it('leaves the legacy plugin folder alone', async () => {
		const legacyMain = `${PLUGINS_DIR}/obsidian-onedrive/main.js`;
		const liveMain = `${PLUGINS_DIR}/alpha/main.js`;

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(legacyMain, { id: 'legacy-main-id' }),
			makeRemoteFile(liveMain, { id: 'alpha-main-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalledWith('legacy-main-id');
		expect(result.downloadedPaths).toEqual([liveMain]);
		expect(result.updated).toEqual(['alpha']);
	});

	it('pulls a plugin even when the sync settings put plugin paths out of scope', async () => {
		// The pull is an explicit, version-gated action of its own, so a
		// shouldSyncPath that refuses every path must not stop it.
		syncEngine = buildEngine('2.1.1', () => false);
		const alphaMain = `${PLUGINS_DIR}/alpha/main.js`;
		mockClient.listAllItems.mockResolvedValue([makeRemoteFile(alphaMain, { id: 'alpha-main-id' })]);

		const result = await syncEngine.pullPluginUpdates();

		expect(result.downloadedPaths).toEqual([alphaMain]);
		expect(result.updated).toEqual(['alpha']);
	});

	it('does not report a plugin id for a file directly under plugins/', async () => {
		const strayPath = `${PLUGINS_DIR}/stray.json`;
		syncEngine = buildEngine('2.1.1', () => true);

		mockClient.listAllItems.mockResolvedValue([makeRemoteFile(strayPath, { id: 'stray-id' })]);

		const result = await syncEngine.pullPluginUpdates();

		expect(result.downloadedPaths).toEqual([strayPath]);
		expect(result.updated).toEqual([]);
	});

	it('honours the .syncIgnore matcher', async () => {
		const ignoredPath = `${PLUGINS_DIR}/alpha/main.js`;
		const keptPath = `${PLUGINS_DIR}/alpha/styles.css`;

		mockApp.vault.adapter.read.mockResolvedValue(ignoredPath);
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(ignoredPath, { id: 'ignored-main-id' }),
			makeRemoteFile(keptPath, { id: 'kept-css-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalledWith('ignored-main-id');
		expect(result.downloadedPaths).toEqual([keptPath]);
	});

	it('ignores remote files outside the plugins tree', async () => {
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile('notes/keep.md', { id: 'note-id' }),
			makeRemoteFile(`${CONFIG_DIR}/app.json`, { id: 'app-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(result.updated).toEqual([]);
	});

	it('leaves the own plugin folder alone when the remote manifest is malformed', async () => {
		mockFileOps.downloadFile.mockResolvedValue(new TextEncoder().encode('not json').buffer);
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(`${OWN_FOLDER}/manifest.json`, { id: 'own-manifest-id' }),
			makeRemoteFile(`${OWN_FOLDER}/main.js`, { id: 'own-main-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(result.skippedOwnFolder).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('manifest'),
			expect.any(Error)
		);
	});

	it('refuses remote paths that leave the vault', async () => {
		const traversalPath = `${PLUGINS_DIR}/../escape/main.js`;

		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(traversalPath, { id: 'traversal-id' }),
			makeRemoteFile(`${PLUGINS_DIR}/alpha/main.js`, {
				id: 'absolute-id',
				__resolvedVaultPath: '/etc/passwd',
			}),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(traversalPath));
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('/etc/passwd'));
	});

	it('treats a pre-release as older than its release', async () => {
		syncEngine = buildEngine('2.2.0');
		mockFileOps.downloadFile.mockResolvedValue(manifestContent('2.2.0-beta'));
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(`${OWN_FOLDER}/manifest.json`, { id: 'own-manifest-id' }),
			makeRemoteFile(`${OWN_FOLDER}/main.js`, { id: 'own-main-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(result.downloadedPaths).toEqual([]);
		expect(result.skippedOwnFolder).toBe(true);
	});

	it('still updates the own plugin folder from a pre-release of a newer version', async () => {
		mockFileOps.downloadFile.mockImplementation(async (id: string) =>
			id === 'own-manifest-id' ? manifestContent('2.2.0-beta') : new ArrayBuffer(10)
		);
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile(`${OWN_FOLDER}/manifest.json`, { id: 'own-manifest-id' }),
			makeRemoteFile(`${OWN_FOLDER}/main.js`, { id: 'own-main-id' }),
		]);

		const result = await syncEngine.pullPluginUpdates();

		expect(result.updated).toEqual(['onedrive-sync']);
		expect(result.skippedOwnFolder).toBe(false);
	});
});
