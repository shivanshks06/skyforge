// Credentials and private keys that must never be baked into a deployment image.
// Databases (.db/.sqlite) and tool config such as .yarnrc.yml are application files, not secrets.
const BLOCKED_SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|service-account(?:\.json)?|application_default_credentials\.json|secrets\.(?:json|ya?ml)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const ALLOWED_ENV_EXAMPLE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;

export function isBlockedSecretFile(name) {
  const value = String(name || "");
  if (ALLOWED_ENV_EXAMPLE.test(value)) return false;
  return BLOCKED_SECRET_FILE.test(value);
}
