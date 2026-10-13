// WebAuthn JSON conversion stays local: credential private keys never enter JavaScript.
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const supported = () => Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
export async function credential(options, registration = false) {
  const publicKey = structuredClone(options);
  publicKey.challenge = decode(publicKey.challenge);
  if (registration) publicKey.user.id = decode(publicKey.user.id);
  for (const field of ['allowCredentials', 'excludeCredentials']) if (publicKey[field]) publicKey[field] = publicKey[field].map(c => ({ ...c, id: decode(c.id) }));
  const result = await navigator.credentials[registration ? 'create' : 'get']({ publicKey });
  if (!result) throw new Error('Passkey cancelled');
  const response = { clientDataJSON: encode(result.response.clientDataJSON) };
  if (registration) { response.attestationObject = encode(result.response.attestationObject); response.transports = result.response.getTransports?.() || []; }
  else { response.authenticatorData = encode(result.response.authenticatorData); response.signature = encode(result.response.signature); response.userHandle = result.response.userHandle ? encode(result.response.userHandle) : null; }
  return { id: result.id, rawId: encode(result.rawId), type: result.type, authenticatorAttachment: result.authenticatorAttachment, clientExtensionResults: result.getClientExtensionResults(), response };
}
export async function ceremony(api, path, body = {}, registration = false) {
  const request = await api('POST', `${path}/options`, body);
  const result = await credential(request.options, registration);
  return api('POST', `${path}/verify`, { challengeId: request.challengeId, credential: result });
}
