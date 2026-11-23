const { Horizon, Networks, Asset, StrKey } = require('@stellar/stellar-sdk');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';

const server = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
);

const networkPassphrase = isTestnet ? Networks.TESTNET : Networks.PUBLIC;

// USDC asset — issuer differs between testnet and mainnet
const USDC = new Asset('USDC', process.env.USDC_ISSUER);

function parseAdditionalAssets(raw = process.env.STELLAR_EXTRA_ASSETS) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    throw new Error('STELLAR_EXTRA_ASSETS must be valid JSON object: {"CODE":"ISSUER"}');
  }
}

const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;

/**
 * Stellar asset type for a credit asset code: 1-4 characters are
 * credit_alphanum4, 5-12 are credit_alphanum12.
 */
function assetTypeForCode(code) {
  return code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
}

/**
 * Validate and type the STELLAR_EXTRA_ASSETS entries. Each code must be 1-12
 * alphanumeric characters and each issuer a valid G... account id; a bad entry
 * fails startup rather than producing an asset Horizon will reject.
 */
function buildExtraAssets(raw = process.env.STELLAR_EXTRA_ASSETS) {
  const assets = {};
  for (const [code, issuer] of Object.entries(parseAdditionalAssets(raw))) {
    if (code === 'XLM' || code === 'USDC') continue;
    if (!ASSET_CODE_PATTERN.test(code)) {
      throw new Error(
        `STELLAR_EXTRA_ASSETS: asset code "${code}" must be 1-12 alphanumeric characters`
      );
    }
    if (typeof issuer !== 'string' || !StrKey.isValidEd25519PublicKey(issuer)) {
      throw new Error(
        `STELLAR_EXTRA_ASSETS: issuer for "${code}" must be a valid Stellar public key (G...)`
      );
    }
    assets[code] = { type: assetTypeForCode(code), issuer };
  }
  return assets;
}

const configuredAssets = {
  XLM: { type: 'native' },
  USDC: { type: 'credit_alphanum4', issuer: process.env.USDC_ISSUER },
};

if (process.env.NGN_ISSUER) {
  configuredAssets.NGN = { type: 'credit_alphanum4', issuer: process.env.NGN_ISSUER };
}

Object.assign(configuredAssets, buildExtraAssets());

module.exports = {
  server,
  networkPassphrase,
  USDC,
  isTestnet,
  configuredAssets,
  assetTypeForCode,
  buildExtraAssets,
};
