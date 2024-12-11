/* The following code is using:
1. The blue-api to fetch data from the Morpho API.
2. The PublicAllocator contract to reallocate liquidity.
3. The TxBuilder to cretae the json to batch.
*/
import "evm-maths";
import { MarketParamsStruct } from "@morpho-org/morpho-blue-bundlers/types/src/MorphoBundler";
import { MaxUint256, ZeroAddress, parseUnits } from "ethers";
import {
  ERC20__factory,
  Morpho__factory,
} from "@morpho-org/morpho-blue-bundlers/types";
import { ethers, AbiCoder, keccak256 } from "ethers";

import "dotenv/config";
import fs from "fs";
import { TxBuilder } from "@morpho-labs/gnosis-tx-builder";
import { PublicAllocator__factory, MorphoBlue__factory } from "ethers-types";

// Define the structure of MarketParams and Withdrawal
/**
 * @notice Structure representing market parameters.
 * @param loanToken Address of the loan token.
 * @param collateralToken Address of the collateral token.
 * @param oracle Address of the oracle.
 * @param irm Address of the interest rate model (IRM).
 * @param lltv Loan-to-Value ratio in bigint.
 */
interface MarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

/**
 * @notice Structure representing a withdrawal.
 * @param marketParams Market parameters for the withdrawal.
 * @param amount Amount to withdraw in bigint.
 */
interface Withdrawal {
  marketParams: MarketParams;
  amount: bigint;
}

// The blue-api url
const API_URL = "https://blue-api.morpho.org/graphql";

// GraphQL Queries
const queries = {
  query2: `
    query MarketByUniqueKey($uniqueKey: String!, $chainId: Int!) {
      marketByUniqueKey(uniqueKey: $uniqueKey, chainId: $chainId) {
        reallocatableLiquidityAssets
        loanAsset {
          address
          decimals
          priceUsd
        }
        state {
          liquidityAssets
          supplyAssets
          borrowAssets
        }
        publicAllocatorSharedLiquidity {
          assets
          vault {
            address
            name
          }
          allocationMarket {
            uniqueKey
            loanAsset {
              address
            }
            collateralAsset {
              address
            }
            irmAddress
            oracle {
              address
            }
            lltv
          }
        }
        loanAsset {
          address
        }
        collateralAsset {
          address
          decimals
        }
        oracle {
          address
        }
        irmAddress
        lltv  
      }
    }
  `,
};

/**
 * @notice Helper function to fetch data from the Morpho API.
 * @param query The GraphQL query string.
 * @param variables Optional variables for the query.
 * @return The JSON response from the API.
 */
export const fetchAPI = async (query: string, variables?: any) => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
};

/**
 * @notice Query market data using a unique key and chain ID.
 * @param uniqueKey The unique key for the market.
 * @param chainId The ID of the blockchain network.
 * @return The market data.
 */
export const queryMarketData = async (
  uniqueKey: string,
  chainId: number
): Promise<any> => {
  const query = queries.query2;
  const data: any = await fetchAPI(query, { uniqueKey, chainId });
  return data?.data?.marketByUniqueKey || {};
};

/**
 * @notice Main function to execute the reallocation process and create transaction JSON.
 * @param marketId The ID of the market to reallocate to.
 * @param chainId The ID of the blockchain network.
 */
const seed = async (
  marketId: string,
  chainId: number,
  loanAmountToSeed: number,
  collatAmountToSeed: number,
  SAFE_ADDRESS: string
) => {
  console.log(`
    Starting the creation of the market to seed...`);

  const marketData = await queryMarketData(marketId, chainId);

  if (!marketData) throw new Error("Market data not found.");

  const collateralTokenAddress = marketData.collateralAsset.address;
  const loanTokenAddress = marketData.loanAsset.address;
  const oracleAddress = marketData.oracle.address;
  const irmAddress = marketData.irmAddress;
  const lltv = marketData.lltv;

  const loanDecimals = BigInt(Number(marketData.loanAsset.decimals));

  const collateralDecimals = BigInt(
    Number(marketData.collateralAsset.decimals)
  );

  const loanAmountToSeedNormalized =
    BigInt(loanAmountToSeed) * BigInt.pow10(loanDecimals);
  console.log("loan asset", loanAmountToSeedNormalized);

  const collateralAmountToSeedNormalized =
    BigInt(collatAmountToSeed) * BigInt.pow10(collateralDecimals);
  console.log("collat asset", collateralAmountToSeedNormalized);

  const morphoAddress = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
  const loanInterface = ERC20__factory.createInterface();
  const collateralInterface = ERC20__factory.createInterface();
  const morphoInterface = MorphoBlue__factory.createInterface();

  const market: MarketParamsStruct = {
    collateralToken: collateralTokenAddress,
    irm: irmAddress,
    lltv: lltv, // "0.945"
    loanToken: loanTokenAddress,
    oracle: oracleAddress,
  };

  const loanApproval = loanInterface.encodeFunctionData("approve", [
    morphoAddress,
    loanAmountToSeedNormalized,
  ]);

  const collateralApproval = collateralInterface.encodeFunctionData("approve", [
    morphoAddress,
    collateralAmountToSeedNormalized,
  ]);

  const supplyLoan = morphoInterface.encodeFunctionData("supply", [
    market,
    loanAmountToSeedNormalized,
    0n,
    SAFE_ADDRESS,
    "0x0000000000000000000000000000000000000000",
  ]);

  const supplyCollat = morphoInterface.encodeFunctionData("supplyCollateral", [
    market,
    collateralAmountToSeedNormalized,
    SAFE_ADDRESS,
    SAFE_ADDRESS,
  ]);
  const borrowLoan = morphoInterface.encodeFunctionData("borrow", [
    market,
    loanAmountToSeedNormalized,
    0n,
    SAFE_ADDRESS,
    "0x0000000000000000000000000000000000000000",
  ]);

  const txBuilder = [
    {
      to: loanTokenAddress,
      value: "0",
      data: loanApproval,
    },
    {
      to: collateralTokenAddress,
      value: "0",
      data: collateralApproval,
    },
    {
      to: morphoAddress,
      value: "0",
      data: supplyLoan,
    },
    // {
    //   to: morphoAddress,
    //   value: "0",
    //   data: supplyCollat,
    // },
    // {
    //   to: morphoAddress,
    //   value: "0",
    //   data: borrowLoan,
    // },
  ];

  console.log(txBuilder);
  const batchJson = TxBuilder.batch(SAFE_ADDRESS, txBuilder);

  await fs.promises.writeFile(
    "seedMarket.json",
    JSON.stringify(batchJson, null, 2)
  );

  console.log(`
    Transaction batch JSON has been created and saved as 'safeBatch.json'.
    `);
};

/* START HERE */
/* 
1. chainId of the network you expect to move liquidity into
2. marketId of the market you expect the borrowers to borrow from, executing the safeTx will bring available liquidity in this market.
*/

const chainId = 1;
const marketId =
  "0xc581c5f70bd1afa283eed57d1418c6432cbff1d862f94eaf58fdd4e46afbb67f";
const loanAmountToSeed = 1;
const collatAmountToSeed = 2;
const SAFE_ADDRESS = "0xD81E0983e8e133d34670728406d08637374e545D"; // The safe address you are expecting to execute with

/* Let's query the API and form the tx that one should execute */
seed(marketId, chainId, loanAmountToSeed, collatAmountToSeed, SAFE_ADDRESS);
