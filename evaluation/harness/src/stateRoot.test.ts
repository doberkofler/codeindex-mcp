import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {assertNoPathDisclosure, pathDisclosureCountOf, pathDisclosuresOf} from './pathDisclosure.ts';
import {assertOutsidePrimaryCheckout, evaluationStateRootOf} from './stateRoot.ts';

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-state-'));
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

describe('state root', () => {
	it('defaults outside the primary checkout and stays stable for one evaluation root', (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const checkout = path.join(root, 'checkout');
		const evaluationRoot = path.join(checkout, 'evaluation');
		const first = evaluationStateRootOf({evaluationRoot, primaryCheckout: checkout, temporaryDirectory: root});
		const second = evaluationStateRootOf({evaluationRoot, primaryCheckout: checkout, temporaryDirectory: root});

		assert.equal(first, second);
		assert.equal(path.relative(checkout, first).startsWith('..'), true);
		assert.match(first, /codeindex-evaluation/u);
	});

	it('rejects configured state and a temporary directory inside the checkout', (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const checkout = path.join(root, 'checkout');
		const evaluationRoot = path.join(checkout, 'evaluation');

		assert.throws(
			() =>
				evaluationStateRootOf({
					evaluationRoot,
					primaryCheckout: checkout,
					environment: {EVALUATION_STATE_ROOT: path.join(checkout, '.state')},
				}),
			/outside the primary checkout/u,
		);
		assert.throws(() => evaluationStateRootOf({evaluationRoot, primaryCheckout: checkout, temporaryDirectory: checkout}), /outside the primary checkout/u);
	});

	it('accepts an explicit state root outside the checkout', (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const checkout = path.join(root, 'checkout');
		const state = path.join(root, 'state');

		assert.equal(
			evaluationStateRootOf({
				evaluationRoot: path.join(checkout, 'evaluation'),
				primaryCheckout: checkout,
				environment: {EVALUATION_STATE_ROOT: state},
			}),
			state,
		);
		assert.doesNotThrow(() => {
			assertOutsidePrimaryCheckout(state, checkout);
		});
	});
});

describe('path disclosure', () => {
	it('finds and counts literal primary-checkout paths without echoing unrelated text', () => {
		const checkout = '/tmp/primary-checkout';
		const text = `first ${checkout}/src/a.ts and again ${checkout}/src/a.ts`;

		assert.deepEqual(pathDisclosuresOf(text, [checkout]), [{rootIndex: 0, prefix: checkout, count: 2}]);
		assert.equal(pathDisclosureCountOf(text, [checkout]), 2);
		assert.equal(pathDisclosureCountOf('relative src/a.ts', [checkout]), 0);
		assert.throws(() => {
			assertNoPathDisclosure(text, [checkout], 'generated configuration');
		}, /generated configuration discloses the primary checkout path/u);
	});
});
