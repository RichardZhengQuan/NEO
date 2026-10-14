/** Updater helpers use injected handles so they can run without Electron. */
export type UpdateCheckResultLike = {
  updateInfo?: { version?: string } | null;
};

export type AutoUpdaterLike = {
  checkForUpdates: () => Promise<UpdateCheckResultLike | null>;
  checkForUpdatesAndNotify: () => Promise<UpdateCheckResultLike | null>;
  on: (event: 'error', listener: (err: Error) => void) => void;
};

export type DialogMessageType = 'info' | 'warning' | 'error' | 'none' | 'question';

export type DialogLike = {
  showMessageBox(opts: { type?: DialogMessageType; title: string; message: string }): Promise<unknown>;
};

export type LoggerLike = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

function logUpdaterError(logger: LoggerLike, err: unknown): void {
  try {
    logger.error('[NEO desktop] updater error:', err);
  } catch {
    // Logging must not turn an updater failure into an uncaught error.
  }
}

export function checkForUpdatesOnReady(opts: {
  autoUpdater: AutoUpdaterLike;
  isPackaged: boolean;
  logger?: LoggerLike;
}): void {
  if (!opts.isPackaged) return;

  const logger = opts.logger ?? console;
  try {
    void opts.autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      logUpdaterError(logger, err);
    });
  } catch (err) {
    logUpdaterError(logger, err);
  }
}

export function attachUpdaterErrorHandler(opts: {
  autoUpdater: AutoUpdaterLike;
  logger?: LoggerLike;
}): void {
  const logger = opts.logger ?? console;
  opts.autoUpdater.on('error', (err) => {
    logUpdaterError(logger, err);
  });
}

export function createCheckForUpdatesHandler(opts: {
  autoUpdater: AutoUpdaterLike;
  dialog: DialogLike;
}): () => Promise<void> {
  return async () => {
    try {
      let message: string;
      let type: DialogMessageType = 'info';
      try {
        const result = await opts.autoUpdater.checkForUpdates();
        const version = result?.updateInfo?.version;
        message = version ? `Downloading NEO ${version}…` : 'NEO is up to date.';
      } catch (err) {
        logUpdaterError(console, err);
        const detail = err instanceof Error ? err.message : String(err);
        message = `Could not check for updates: ${detail}`;
        type = 'error';
      }

      await opts.dialog.showMessageBox({ type, title: 'NEO updates', message });
    } catch (err) {
      logUpdaterError(console, err);
    }
  };
}
