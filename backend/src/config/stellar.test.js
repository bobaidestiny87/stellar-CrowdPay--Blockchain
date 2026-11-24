const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@stellar/stellar-sdk');
const { assetTypeForCode, buildExtraAssets } = require('./stellar');

const ISSUER = Keypair.random().publicKey();

test('asset type follows the code length (#397)', () => {
  assert.equal(assetTypeForCode('A'), 'credit_alphanum4');
  assert.equal(assetTypeForCode('EURC'), 'credit_alphanum4');
  assert.equal(assetTypeForCode('EURCV'), 'credit_alphanum12');
  assert.equal(assetTypeForCode('ABCDEFGHIJKL'), 'credit_alphanum12');
});

test('STELLAR_EXTRA_ASSETS entries get the type their code length requires', () => {
  const assets = buildExtraAssets(JSON.stringify({ EURC: ISSUER, LONGCODE12: ISSUER }));
  assert.deepEqual(assets.EURC, { type: 'credit_alphanum4', issuer: ISSUER });
  assert.deepEqual(assets.LONGCODE12, { type: 'credit_alphanum12', issuer: ISSUER });
});

test('XLM and USDC in STELLAR_EXTRA_ASSETS are ignored', () => {
  assert.deepEqual(buildExtraAssets(JSON.stringify({ XLM: ISSUER, USDC: ISSUER })), {});
});

test('a bad issuer fails with a clear error', () => {
  for (const issuer of ['not-a-key', 'S' + ISSUER.slice(1), '', 42]) {
    assert.throws(
      () => buildExtraAssets(JSON.stringify({ EURC: issuer })),
      /issuer for "EURC" must be a valid Stellar public key/,
      String(issuer)
    );
  }
});

test('an invalid asset code fails with a clear error', () => {
  for (const code of ['TOOLONGCODE13', 'BAD-CODE', 'EUR C']) {
    assert.throws(
      () => buildExtraAssets(JSON.stringify({ [code]: ISSUER })),
      /must be 1-12 alphanumeric characters/,
      code
    );
  }
});

test('unset or invalid JSON behaves as before', () => {
  assert.deepEqual(buildExtraAssets(undefined), {});
  assert.throws(() => buildExtraAssets('{not json'), /must be valid JSON object/);
});
