import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AVALANCHE_FUJI_CHAIN_ID,
  feeConfigTupleFromJson,
  LIVE_LANE_REMOTE_GAS_PRICE_SKEW,
  testnetMinFeeConfigsForChain,
  type FeeConfigJson,
} from "../scripts/deploy-utils.js";

describe("live-lane gas-price skew templates", () => {
  it("Hardhat keeps identity remote skew", () => {
    const { remote } = testnetMinFeeConfigsForChain(31337);
    assert.equal(remote.gasPriceMul, 1n);
    assert.equal(remote.gasPriceDiv, 1n);
  });

  it("Sepolia remote uses 5/1; Fuji remote uses 13/1; COTI remote uses 1/10", () => {
    const sepolia = testnetMinFeeConfigsForChain(11155111);
    assert.equal(sepolia.remote.gasPriceMul, LIVE_LANE_REMOTE_GAS_PRICE_SKEW.sepoliaToCoti.gasPriceMul);
    assert.equal(sepolia.remote.gasPriceDiv, LIVE_LANE_REMOTE_GAS_PRICE_SKEW.sepoliaToCoti.gasPriceDiv);

    const fuji = testnetMinFeeConfigsForChain(AVALANCHE_FUJI_CHAIN_ID);
    assert.equal(fuji.remote.gasPriceMul, LIVE_LANE_REMOTE_GAS_PRICE_SKEW.fujiToCoti.gasPriceMul);
    assert.equal(fuji.remote.gasPriceDiv, LIVE_LANE_REMOTE_GAS_PRICE_SKEW.fujiToCoti.gasPriceDiv);

    const coti = testnetMinFeeConfigsForChain(7082400);
    assert.equal(coti.remote.gasPriceMul, LIVE_LANE_REMOTE_GAS_PRICE_SKEW.cotiToL1.gasPriceMul);
    assert.equal(coti.remote.gasPriceDiv, LIVE_LANE_REMOTE_GAS_PRICE_SKEW.cotiToL1.gasPriceDiv);
  });

  it("JSON loader requires gasPriceMul and gasPriceDiv", () => {
    const base = {
      constantFee: "0",
      gasPerByte: "1",
      callbackExecutionGas: "1",
      errorLength: "1",
      bufferRatioX10000: "1",
      maxMethodCallBytes: "100",
      maxExecutionGas: "1000",
    };
    assert.throws(
      () => feeConfigTupleFromJson(base as FeeConfigJson),
      /gasPriceMul and gasPriceDiv/
    );
    const ok = feeConfigTupleFromJson({ ...base, gasPriceMul: 5, gasPriceDiv: 1 });
    assert.equal(ok.gasPriceMul, 5n);
    assert.equal(ok.gasPriceDiv, 1n);
  });
});
