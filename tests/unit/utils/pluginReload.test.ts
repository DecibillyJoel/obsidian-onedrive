/**
 * Unit tests for plugin reload utilities
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { App } from 'obsidian';
import { reloadPlugins } from '../../../src/utils/pluginReload';
import { timerApi } from '../../../src/utils/timerApi';

interface FakePluginManager {
	disablePlugin: ReturnType<typeof vi.fn>;
	enablePlugin: ReturnType<typeof vi.fn>;
	loadManifests: ReturnType<typeof vi.fn>;
}

function makeManager(calls: string[] = []): FakePluginManager {
	return {
		disablePlugin: vi.fn(async (id: string) => {
			calls.push(`disable:${id}`);
		}),
		enablePlugin: vi.fn(async (id: string) => {
			calls.push(`enable:${id}`);
			return true;
		}),
		loadManifests: vi.fn(async () => {
			calls.push('loadManifests');
		}),
	};
}

function makeApp(plugins?: unknown): App {
	return { plugins } as unknown as App;
}

describe('reloadPlugins', () => {
	afterEach(() => vi.restoreAllMocks());

	it('fails every id and reloads nothing when the manager is missing', async () => {
		const result = await reloadPlugins(makeApp(undefined), ['a', 'b']);

		expect(result.reloaded).toEqual([]);
		expect(result.failed).toEqual([
			{ id: 'a', error: 'PluginManagerUnavailable' },
			{ id: 'b', error: 'PluginManagerUnavailable' },
		]);
	});

	it('fails every id when a required manager method is missing', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		const partial = {
			disablePlugin: manager.disablePlugin,
			enablePlugin: manager.enablePlugin,
		};

		const result = await reloadPlugins(makeApp(partial), ['a']);

		expect(result.failed).toEqual([{ id: 'a', error: 'PluginManagerUnavailable' }]);
		expect(result.reloaded).toEqual([]);
		expect(manager.disablePlugin).not.toHaveBeenCalled();
		expect(manager.enablePlugin).not.toHaveBeenCalled();
	});

	it('disables, reloads manifests, then enables each id in order', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);

		const result = await reloadPlugins(makeApp(manager), ['a', 'b']);

		expect(calls).toEqual([
			'disable:a',
			'loadManifests',
			'enable:a',
			'disable:b',
			'loadManifests',
			'enable:b',
		]);
		expect(result.reloaded).toEqual(['a', 'b']);
		expect(result.failed).toEqual([]);
	});

	it('awaits a pending disable before it calls enable', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		let resolveDisable: (() => void) | undefined;
		manager.disablePlugin.mockImplementation(
			(id: string) =>
				new Promise<void>((resolve) => {
					calls.push(`disable:${id}`);
					resolveDisable = resolve;
				})
		);

		const pending = reloadPlugins(makeApp(manager), ['a']);

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(calls).toEqual(['disable:a']);
		expect(manager.enablePlugin).not.toHaveBeenCalled();

		resolveDisable?.();
		const result = await pending;

		expect(calls).toEqual(['disable:a', 'loadManifests', 'enable:a']);
		expect(result.reloaded).toEqual(['a']);
		expect(result.failed).toEqual([]);
	});

	it('schedules the self id last and counts it as reloaded once scheduled', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		let deferred: (() => void | Promise<void>) | undefined;
		const timeoutSpy = vi
			.spyOn(timerApi, 'setTimeout')
			.mockImplementation((handler: () => void) => {
				deferred = handler;
				return 0;
			});

		const result = await reloadPlugins(makeApp(manager), ['other', 'self'], 'self');

		expect(result.reloaded).toEqual(['other', 'self']);
		expect(result.failed).toEqual([]);
		expect(timeoutSpy).toHaveBeenCalledTimes(1);
		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
		expect(calls).toEqual(['disable:other', 'loadManifests', 'enable:other']);

		expect(deferred).toBeTypeOf('function');
		await deferred?.();

		expect(calls).toEqual([
			'disable:other',
			'loadManifests',
			'enable:other',
			'disable:self',
			'loadManifests',
			'enable:self',
		]);
	});

	it('keeps reloading after one id throws', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		manager.disablePlugin.mockImplementation((id: string) => {
			calls.push(`disable:${id}`);
			if (id === 'bad') {
				throw new Error('disable exploded');
			}
			return Promise.resolve();
		});

		const result = await reloadPlugins(makeApp(manager), ['bad', 'good']);

		expect(result.reloaded).toEqual(['good']);
		expect(result.failed).toEqual([{ id: 'bad', error: 'disable exploded' }]);
		expect(calls).toEqual([
			'disable:bad',
			'disable:good',
			'loadManifests',
			'enable:good',
		]);
	});

	it('ignores an id whose enable resolves false', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		manager.enablePlugin.mockImplementation(async (id: string) => {
			calls.push(`enable:${id}`);
			return id !== 'missing';
		});

		const result = await reloadPlugins(makeApp(manager), ['missing']);

		expect(result.reloaded).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it('treats a promise of false from enable as not reloaded', async () => {
		const manager = makeManager();
		manager.enablePlugin.mockImplementation(() => Promise.resolve(false));

		const result = await reloadPlugins(makeApp(manager), ['uninstalled']);

		expect(result.reloaded).toEqual([]);
		expect(result.failed).toEqual([]);
	});
});
