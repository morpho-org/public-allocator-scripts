import { ethers } from "ethers";
import "dotenv/config";
import fs from "fs";
import { TxBuilder } from "@morpho-labs/gnosis-tx-builder";

// Define MarketParams interface
interface MarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

// Sample mapping of IDs to MarketParams (Replace this with your actual mapping)
const marketParamsMapping: MarketParams[] = [
  {
    loanToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    collateralToken: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    oracle: "0x5D916980D5Ae1737a8330Bf24dF812b2911Aae25",
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    lltv: 860000000000000000n,
  },
  // Add other MarketParams objects as needed
];

// Function to compute the keccak256 hash of MarketParams
const computeId = (marketParams: MarketParams): string => {
  const encoded = new ethers.AbiCoder().encode(
    ["address", "address", "address", "address", "uint256"],
    [
      marketParams.loanToken,
      marketParams.collateralToken,
      marketParams.oracle,
      marketParams.irm,
      marketParams.lltv,
    ]
  );
  return ethers.keccak256(encoded);
};

// Function to get MarketParams from id
const getMarketParamsFromId = (id: string): MarketParams | null => {
  console.log(id);
  for (const params of marketParamsMapping) {
    if (computeId(params) === id) {
      console.group(params);
      return params;
    }
  }
  return null;
};

getMarketParamsFromId(
  "0x39d11026eae1c6ec02aa4c0910778664089cdd97c3fd23f68f7cd05e2e95af48"
);
