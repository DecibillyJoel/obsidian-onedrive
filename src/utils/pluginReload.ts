/**
 * Community plugin reload utilities.
 *
 * Obsidian does not declare its plugin manager in `obsidian.d.ts`, so this
 * module describes only the members it calls and casts the app, following
 * the convention used in `main.ts`.
 */

import type { App } from 'obsidian';
import { logger } from './logger';
import { timerApi } from './timerApi';

export interface PluginReloadResult {
	reloaded: string[];
	failed: Array<{ id: string; error: string }>;
}

interface PluginManagerLike {
	disablePlugin?: (id: string) => Promise<void> | void;
	enablePlugin?: (id: string) => Promise<boolean> | boolean;
	loadManifests?: () => Promise<void> | void;
}

type PluginManager = Required<PluginManagerLike>;

interface AppWithPlugins {
	plugins?: PluginManagerLike;
}

function getPluginManager(app: App): PluginManager | null {
	const plugins = (app as unknown as AppWithPlugins).plugins;
	if (
		plugins &&
		typeof plugins.disablePlugin === 'function' &&
		typeof plugins.enablePlugin === 'function' &&
		typeof plugins.loadManifests === 'function'
	) {
		return plugins as PluginManager;
	}
	return null;
}

/**
 * Run one reload in the same order Obsidian's `plugin:reload` uses.
 *
 * The function awaits each manager call in turn. Returns false when
 * `enablePlugin` reports that the plugin is not installed.
 */
async function reloadOne(
	plugins: PluginManager,
	id: string
): Promise<boolean> {
	await plugins.disablePlugin(id);
	await plugins.loadManifests();
	const enabled = await plugins.enablePlugin(id);
	return enabled !== false;
}

function describeError(error: unknown): string {
	return (error as Error)?.message || String(error);
}

/**
 * Reload the given plugins.
 *
 * The function awaits the manager methods of each id in order: disable,
 * then load manifests, then enable. It continues with the next id when one
 * id fails.
 *
 * The self id reloads from a zero-delay timer, so the caller returns first
 * and its own unload runs afterwards. The self id reloads only when `ids`
 * contains it. The self entry in `reloaded` means "scheduled". A self reload
 * failure reaches the log only.
 */
export async function reloadPlugins(
	app: App,
	ids: string[],
	selfId?: string
): Promise<PluginReloadResult> {
	const result: PluginReloadResult = { reloaded: [], failed: [] };
	const plugins = getPluginManager(app);

	if (!plugins) {
		for (const id of ids) {
			result.failed.push({ id, error: 'PluginManagerUnavailable' });
		}
		return result;
	}

	for (const id of ids) {
		if (selfId && id === selfId) {
			continue;
		}
		try {
			if (await reloadOne(plugins, id)) {
				result.reloaded.push(id);
			}
		} catch (error) {
			result.failed.push({ id, error: describeError(error) });
		}
	}

	if (selfId && ids.includes(selfId)) {
		timerApi.setTimeout(async () => {
			try {
				await reloadOne(plugins, selfId);
			} catch (error) {
				logger.error(
					`Failed to reload plugin ${selfId}: ${describeError(error)}`
				);
			}
		}, 0);
		result.reloaded.push(selfId);
	}

	return result;
}
