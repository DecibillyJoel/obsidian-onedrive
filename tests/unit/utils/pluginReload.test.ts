/**
 * Unit tests for plugin reload utilities
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { App } from 'obsidian';
import { reloadPlugins } from '../../../src/utils/pluginReload';
import { timerApi } from '../../../src/utils/timerApi';
import { logger } from '../../../src/utils/logger';

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

/** Let every queued microtask run. */
async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
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

	it('awaits a pending loadManifests before it calls enable', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		let resolveManifests: (() => void) | undefined;
		manager.loadManifests.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					calls.push('loadManifests');
					resolveManifests = resolve;
				})
		);

		const pending = reloadPlugins(makeApp(manager), ['a']);

		await flushMicrotasks();

		expect(calls).toEqual(['disable:a', 'loadManifests']);
		expect(manager.enablePlugin).not.toHaveBeenCalled();

		resolveManifests?.();
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
		deferred?.();
		await flushMicrotasks();

		expect(calls).toEqual([
			'disable:other',
			'loadManifests',
			'enable:other',
			'disable:self',
			'loadManifests',
			'enable:self',
		]);
	});

	it('does not leak an unhandled rejection when the self reload log call throws', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		let deferred: (() => void | Promise<void>) | undefined;
		vi.spyOn(timerApi, 'setTimeout').mockImplementation(
			(handler: () => void) => {
				deferred = handler;
				return 0;
			}
		);
		manager.enablePlugin.mockRejectedValue(new Error('enable exploded'));
		const logError = vi.spyOn(logger, 'error').mockImplementation(() => {
			throw new Error('log sink exploded');
		});
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);

		try {
			const result = await reloadPlugins(makeApp(manager), ['self'], 'self');

			expect(result.reloaded).toEqual(['self']);
			expect(deferred).toBeTypeOf('function');
			expect(() => deferred?.()).not.toThrow();

			await flushMicrotasks();

			expect(logError).toHaveBeenCalledTimes(1);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
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

	it('records nothing for an id whose enable reports it is not installed', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		manager.enablePlugin.mockImplementation((id: string) => {
			calls.push(`enable:${id}`);
			return Promise.resolve(id !== 'missing');
		});

		const result = await reloadPlugins(makeApp(manager), ['missing', 'present']);

		expect(manager.enablePlugin).toHaveBeenCalledWith('missing');
		expect(manager.enablePlugin).toHaveBeenCalledWith('present');
		expect(result.reloaded).toEqual(['present']);
		expect(result.failed).toEqual([]);
		expect(calls).toEqual([
			'disable:missing',
			'loadManifests',
			'enable:missing',
			'disable:present',
			'loadManifests',
			'enable:present',
		]);
	});

	it('does not schedule a self reload when ids omits the self id', async () => {
		const calls: string[] = [];
		const manager = makeManager(calls);
		const timeoutSpy = vi.spyOn(timerApi, 'setTimeout');

		const result = await reloadPlugins(makeApp(manager), ['other'], 'self');

		expect(result.reloaded).toEqual(['other']);
		expect(result.failed).toEqual([]);
		expect(timeoutSpy).not.toHaveBeenCalled();
		expect(calls).toEqual(['disable:other', 'loadManifests', 'enable:other']);
	});
});
