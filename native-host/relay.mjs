/**
 * Host relay logic (pure, testable). The native host is a thin, honest relay:
 * extension <-> host <-> desktop app. It validates every envelope against the
 * shared protocol, forwards valid ones, and answers cleanly when the app is not
 * running instead of dropping messages. It NEVER inspects or stores payload
 * secrets (there are none in the protocol) and never originates commands.
 */
import { validateMessage, error as errorMsg, MSG } from '../shared/protocol/messages.mjs';

/**
 * @param {{
 *   sendExtension:(msg:object)=>void,
 *   sendApp:(msg:object)=>boolean,   // returns false if the app is unreachable
 *   appConnected:()=>boolean,
 *   log?:Function
 * }} io
 */
export function createRelay(io) {
  const log = io.log || (() => {});

  function onExtensionMessage(raw) {
    const v = validateMessage(raw);
    if (!v.ok) {
      io.sendExtension(v.versionMismatch
        ? errorMsg('E_PROTOCOL_VERSION', 'Version de protocole incompatible entre extension et application.')
        : errorMsg('E_BAD_MESSAGE', `Message invalide : ${v.errors.join(' ')}`));
      return false;
    }
    if (!io.appConnected()) {
      io.sendExtension(errorMsg('E_APP_DOWN', 'Application Eloshon Scraper fermée : ouvrez-la pour lancer un travail.', { retriable: true }));
      log({ event: 'app_down', type: raw.type });
      return false;
    }
    const ok = io.sendApp(raw);
    if (!ok) io.sendExtension(errorMsg('E_APP_DOWN', 'Application injoignable.', { retriable: true }));
    return ok;
  }

  function onAppMessage(raw) {
    const v = validateMessage(raw);
    if (!v.ok) { log({ event: 'app_bad_message', errors: v.errors }); return false; }
    io.sendExtension(raw);
    return true;
  }

  return { onExtensionMessage, onAppMessage };
}
