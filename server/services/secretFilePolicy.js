const BLOCKED_SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|service-account(?:\.json)?|application_default_credentials\.json|secrets\.(?:json|ya?ml)|.*\.(?:pem|key|p12|pfx|jks|keystore|sqlite|db))$/i;
const ALLOWED_ENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/i;

export function isBlockedSecretFile(name) {
  const value = String(name || "");
  if (ALLOWED_ENV_EXAMPLE.test(value)) return false;
  return BLOCKED_SECRET_FILE.test(value);
}
