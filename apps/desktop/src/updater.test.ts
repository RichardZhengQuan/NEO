import { afterEach, describe, it, expect, vi } from 'vitest';
import type { AutoUpdaterLike, DialogLike, LoggerLike, UpdateCheckResultLike } from './updater.js';
import {
  attachUpdaterErrorHandler,
  checkForUpdatesOnReady,
  createCheckForUpdatesHandler,
} from './updater.js';

function makeAutoUpdater(result: UpdateCheckResultLike | null = null) {
  return {
    checkForUpdates: vi.fn<AutoUpdaterLike['checkForUpdates']>().mockResolvedValue(result),
    checkForUpdatesAndNotify: vi.fn<AutoUpdaterLike['checkForUpdatesAndNotify']>().mockResolvedValue(result),
    on: vi.fn<AutoUpdaterLike['on']>(),
  };
}

function makeLogger() {
  return {
    info: vi.fn<LoggerLike['info']>(),
    error: vi.fn<LoggerLike['error']>(),
  };
}

function makeDialog() {
  return {
    showMessageBox: vi.fn<DialogLike['showMessageBox']>().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkForUpdatesOnReady', () => {
  it('checks and notifies exactly once when the app is packaged', () => {
    const autoUpdater = makeAutoUpdater();

    checkForUpdatesOnReady({ autoUpdater, isPackaged: true });

    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('does not check or notify when the app is not packaged', () => {
    const autoUpdater = makeAutoUpdater();

    checkForUpdatesOnReady({ autoUpdater, isPackaged: false });

    expect(autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('logs a rejected check through the provided logger without throwing', async () => {
    const autoUpdater = makeAutoUpdater();
    const logger = makeLogger();
    const error = new Error('Update server unavailable');
    const rejected = Promise.reject(error);
    autoUpdater.checkForUpdatesAndNotify.mockReturnValue(rejected);

    expect(() => checkForUpdatesOnReady({ autoUpdater, isPackaged: true, logger })).not.toThrow();
    await rejected.catch(() => undefined);

    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('logs a synchronous check failure without throwing', () => {
    const autoUpdater = makeAutoUpdater();
    const logger = makeLogger();
    const error = new Error('Missing update configuration');
    autoUpdater.checkForUpdatesAndNotify.mockImplementation(() => { throw error; });

    expect(() => checkForUpdatesOnReady({ autoUpdater, isPackaged: true, logger })).not.toThrow();

    expect(autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('uses console.error when no logger is provided', async () => {
    const autoUpdater = makeAutoUpdater();
    const error = new Error('Update server unavailable');
    const rejected = Promise.reject(error);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    autoUpdater.checkForUpdatesAndNotify.mockReturnValue(rejected);

    checkForUpdatesOnReady({ autoUpdater, isPackaged: true });
    await rejected.catch(() => undefined);

    expect(logError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('contains a failing logger when a startup check throws', () => {
    const autoUpdater = makeAutoUpdater();
    const logger = makeLogger();
    const error = new Error('Missing update configuration');
    autoUpdater.checkForUpdatesAndNotify.mockImplementation(() => { throw error; });
    logger.error.mockImplementation(() => { throw new Error('Logger unavailable'); });

    expect(() => checkForUpdatesOnReady({ autoUpdater, isPackaged: true, logger })).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(expect.any(String), error);
  });
});

describe('attachUpdaterErrorHandler', () => {
  it('registers an error listener that logs the emitted error without throwing', () => {
    const autoUpdater = makeAutoUpdater();
    const logger = makeLogger();
    const error = new Error('Download failed');

    attachUpdaterErrorHandler({ autoUpdater, logger });

    expect(autoUpdater.on).toHaveBeenCalledTimes(1);
    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    const listener = autoUpdater.on.mock.calls[0]![1];
    expect(() => listener(error)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[NEO desktop] updater error:', error);
  });

  it('uses console as the default logger', () => {
    const autoUpdater = makeAutoUpdater();
    const error = new Error('Download failed');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    attachUpdaterErrorHandler({ autoUpdater });

    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    const listener = autoUpdater.on.mock.calls[0]![1];
    expect(() => listener(error)).not.toThrow();
    expect(logError).toHaveBeenCalledWith('[NEO desktop] updater error:', error);
  });

  it('does not let a failing logger escape the registered listener', () => {
    const autoUpdater = makeAutoUpdater();
    const logger = makeLogger();
    const error = new Error('Download failed');
    logger.error.mockImplementation(() => { throw new Error('Logger unavailable'); });

    attachUpdaterErrorHandler({ autoUpdater, logger });

    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    const listener = autoUpdater.on.mock.calls[0]![1];
    expect(() => listener(error)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('[NEO desktop] updater error:', error);
  });
});

describe('createCheckForUpdatesHandler', () => {
  it('checks once and says NEO is up to date when the result is null', async () => {
    const autoUpdater = makeAutoUpdater(null);
    const dialog = makeDialog();
    const handler = createCheckForUpdatesHandler({ autoUpdater, dialog });

    expect(typeof handler).toBe('function');
    await expect(handler()).resolves.toBeUndefined();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'NEO is up to date.',
    }));
  });

  it.each([
    ['null updateInfo', { updateInfo: null }],
    ['undefined updateInfo', {}],
    ['updateInfo without a version', { updateInfo: {} }],
  ] as const)('says NEO is up to date for %s', async (_name, result) => {
    const autoUpdater = makeAutoUpdater(result);
    const dialog = makeDialog();

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'NEO is up to date.',
    }));
  });

  it('says Downloading NEO 1.2.3… when updateInfo contains the version', async () => {
    const autoUpdater = makeAutoUpdater({ updateInfo: { version: '1.2.3' } });
    const dialog = makeDialog();

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Downloading NEO 1.2.3…',
    }));
  });

  it('shows the rejected check error and logs it without rethrowing', async () => {
    const autoUpdater = makeAutoUpdater();
    const dialog = makeDialog();
    const error = new Error('Update server unavailable');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    autoUpdater.checkForUpdates.mockRejectedValue(error);

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Could not check for updates: Update server unavailable',
    }));
    expect(logError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('shows a synchronous check error without rethrowing', async () => {
    const autoUpdater = makeAutoUpdater();
    const dialog = makeDialog();
    const error = new Error('Missing update configuration');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    autoUpdater.checkForUpdates.mockImplementation(() => { throw error; });

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Could not check for updates: Missing update configuration',
    }));
    expect(logError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('converts a non-Error rejection into the visible failure message', async () => {
    const autoUpdater = makeAutoUpdater();
    const dialog = makeDialog();
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    autoUpdater.checkForUpdates.mockRejectedValue('Offline');

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Could not check for updates: Offline',
    }));
    expect(logError).toHaveBeenCalledWith(expect.any(String), 'Offline');
  });

  it('logs a rejected dialog without rethrowing or showing another dialog', async () => {
    const autoUpdater = makeAutoUpdater();
    const dialog = makeDialog();
    const error = new Error('Dialog unavailable');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dialog.showMessageBox.mockRejectedValue(error);

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('contains a dialog rejection even if console.error throws', async () => {
    const autoUpdater = makeAutoUpdater();
    const dialog = makeDialog();
    const error = new Error('Dialog unavailable');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('Logger unavailable'); });
    dialog.showMessageBox.mockRejectedValue(error);

    await expect(createCheckForUpdatesHandler({ autoUpdater, dialog })()).resolves.toBeUndefined();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.any(String), error);
  });
});
