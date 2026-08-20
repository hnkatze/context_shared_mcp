export type ConsentFields = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly scope: string;
  readonly resource: string;
};

/** Every value here reaches the page from a query string, so escaping is not
 *  optional: an unescaped redirect_uri is a reflected XSS on the login form. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Dynamic registration lets any client name its own callback, so the human
 *  authorizing has to be able to see where the code is about to go. */
function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center;
         background: Canvas; color: CanvasText; }
  main { width: min(28rem, 92vw); padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { margin: 0 0 1.5rem; opacity: .75; font-size: .9rem; }
  label { display: block; font-size: .8rem; font-weight: 600;
          text-transform: uppercase; letter-spacing: .04em; margin-bottom: .5rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .7rem .8rem;
          font: inherit; font-family: ui-monospace, monospace;
          border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
          border-radius: .5rem; background: Canvas; color: CanvasText; }
  input[type=password]:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem 1rem; font: inherit;
           font-weight: 600; border: 0; border-radius: .5rem;
           background: CanvasText; color: Canvas; cursor: pointer; }
  .error { color: #b3261e; font-size: .875rem; margin: 0 0 1rem; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .error { color: #f2b8b5; } }
  .grant { font-size: .8rem; opacity: .6; margin: 1.25rem 0 0; }
`;

/**
 * There is no user database behind this page. Holding a live API key IS the
 * proof of authorization, which is why the form asks for one and nothing else.
 */
export function consentPage(fields: ConsentFields, error?: string): string {
  const errorBlock =
    error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to the context board</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Connect to the context board</h1>
  <p>Paste an API key for your organization. Claude receives a short-lived token
     for this server only — never the key itself.</p>
  ${errorBlock}
  <form method="post" action="/authorize">
    ${hidden("response_type", "code")}
    ${hidden("client_id", fields.clientId)}
    ${hidden("redirect_uri", fields.redirectUri)}
    ${hidden("code_challenge", fields.codeChallenge)}
    ${hidden("code_challenge_method", "S256")}
    ${hidden("state", fields.state)}
    ${hidden("scope", fields.scope)}
    ${hidden("resource", fields.resource)}
    <label for="api_key">API key</label>
    <input id="api_key" name="api_key" type="password" autocomplete="off"
           spellcheck="false" autocapitalize="off" required
           placeholder="ctx_…">
    <button type="submit">Authorize</button>
  </form>
  <p class="grant">Granting <code>${escapeHtml(fields.scope)}</code> access to
     <code>${escapeHtml(fields.resource)}</code>.<br>
     You will be returned to <strong>${escapeHtml(redirectHost(fields.redirectUri))}</strong>.</p>
</main>
</body>
</html>`;
}
