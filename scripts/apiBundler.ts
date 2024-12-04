/* The following code is using:
1. The blue-api to fetch data from the Morpho API.
2. The Bundler contract to reallocate liquidity.
*/

import { AbiCoder, keccak256 } from "ethers";
import "dotenv/config";
import fs from "fs";
import { BaseBundlerV2__factory } from "@morpho-org/morpho-blue-bundlers/types";
import { BundlerAction } from "@morpho-org/morpho-blue-bundlers/pkg";

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

// GraphQL Queries
const queries = {
  query1: `
    query PublicAllocators($chainId: Int!) {
      publicAllocators(where: { chainId_in: [$chainId] }) {
        items {
          address
          creationBlockNumber
          morphoBlue {
            address
            chain {
              id
              network
            }
          }
        }
      }
    }
  `,
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

const BUFFER_FACTOR_NUMERATOR = 1001n;
const BUFFER_FACTOR_DENOMINATOR = 1000n;
const API_URL = "https://blue-api.morpho.org/graphql";

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
 * @notice Query the public allocator address for a given chain ID.
 * @param chainId The ID of the blockchain network.
 * @return The address of the public allocator.
 */
export const queryPublicAllocatorAddress = async (
  chainId: number
): Promise<string> => {
  const query = queries.query1;
  const data: any = await fetchAPI(query, { chainId });
  const address = data?.data?.publicAllocators?.items?.[0]?.address || "";
  return address;
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
 * @notice Extract data from market data for withdrawals and supply market parameters.
 * @param marketData The market data object.
 * @param liquidity The liquidity to reallocate as a bigint.
 * @return An object containing withdrawals grouped by vault, supply market parameters, and a summary.
 */
const extractDataForReallocation = (marketData: any, liquidity: bigint) => {
  const withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] } = {};
  const availableLiquidity = BigInt(marketData.state.liquidityAssets);

  let liquidityNeededFromReallocation = 0n;

  // Determine if we need to reallocate liquidity
  if (liquidity > availableLiquidity) {
    liquidityNeededFromReallocation =
      ((liquidity - availableLiquidity) * BUFFER_FACTOR_NUMERATOR) /
      BUFFER_FACTOR_DENOMINATOR;
  }

  let totalReallocated = 0n;

  // First, group and sum assets by vault
  const vaultTotalAssets = marketData.publicAllocatorSharedLiquidity.reduce(
    (acc: { [key: string]: bigint }, item: any) => {
      const vaultAddress = item.vault.address;
      acc[vaultAddress] = (acc[vaultAddress] || 0n) + BigInt(item.assets);
      return acc;
    },
    {}
  );

  // Sort vaults by total assets (descending)
  const sortedVaults = Object.entries(vaultTotalAssets).sort(
    ([, a], [, b]) => Number(b) - Number(a)
  );

  // Process each vault's allocations
  let remainingLiquidityNeeded = liquidityNeededFromReallocation;

  for (const [vaultAddress] of sortedVaults) {
    if (remainingLiquidityNeeded <= 0n) break;

    const vaultAllocations = marketData.publicAllocatorSharedLiquidity.filter(
      (item: any) => item.vault.address === vaultAddress
    );

    for (const item of vaultAllocations) {
      const itemAmount = BigInt(item.assets);

      if (remainingLiquidityNeeded <= 0n) break;

      // Calculate how much we can take from this allocation
      const amountToTake =
        itemAmount < remainingLiquidityNeeded
          ? itemAmount
          : remainingLiquidityNeeded;

      remainingLiquidityNeeded -= amountToTake;
      totalReallocated += amountToTake;

      const withdrawal: Withdrawal = {
        marketParams: {
          loanToken: item.allocationMarket.loanAsset.address,
          collateralToken: item.allocationMarket.collateralAsset.address,
          oracle: item.allocationMarket.oracle.address,
          irm: item.allocationMarket.irmAddress,
          lltv: BigInt(item.allocationMarket.lltv),
        },
        amount: amountToTake,
      };

      if (!withdrawalsPerVault[vaultAddress]) {
        withdrawalsPerVault[vaultAddress] = [];
      }

      withdrawalsPerVault[vaultAddress].push(withdrawal);
    }
  }

  const supplyMarketParams: MarketParams = {
    loanToken: marketData.loanAsset.address,
    collateralToken: marketData.collateralAsset.address,
    oracle: marketData.oracle.address,
    irm: marketData.irmAddress,
    lltv: BigInt(marketData.lltv),
  };

  const totalLiquidityProvided = availableLiquidity + totalReallocated;

  const summary = {
    requestedLiquidity: liquidity,
    totalLiquidityProvided,
    totalReallocated,
    liquidityShortfall:
      totalLiquidityProvided >= liquidity
        ? 0n
        : liquidity - totalLiquidityProvided,
    isLiquidityFullyMatched: totalLiquidityProvided >= liquidity,
  };

  return { withdrawalsPerVault, supplyMarketParams, summary };
};

/**
 * @notice Encode the market parameters to get a market ID.
 * @param market The market parameters.
 * @return The market ID as a string.
 */
export const getMarketId = (market: MarketParams) => {
  const encodedMarket = AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "uint256"],
    [
      market.loanToken,
      market.collateralToken,
      market.oracle,
      market.irm,
      market.lltv,
    ]
  );
  return keccak256(encodedMarket);
};

/**
 * @notice Main function to execute the reallocation process and create transaction JSON.
 * @param marketId The ID of the market to reallocate to.
 * @param chainId The ID of the blockchain network.
 * @param liquidity The liquidity to reallocate as a bigint.
 */
const reallocateTo = async (
  marketId: string,
  chainId: number,
  liquidity: bigint
) => {
  console.log(`
    Starting reallocation process...`);

  const publicAllocatorAddress = await queryPublicAllocatorAddress(chainId);
  if (!publicAllocatorAddress)
    throw new Error(`Public Allocator Address not found.`);

  console.log(`
    Public Allocator Address: ${publicAllocatorAddress}`);

  const marketData = await queryMarketData(marketId, chainId);
  if (!marketData) throw new Error("Market data not found.");

  const { withdrawalsPerVault, supplyMarketParams, summary } =
    extractDataForReallocation(marketData, liquidity);

  console.log(
    `
    Withdrawals by Vault: `,
    withdrawalsPerVault
  );

  console.log("Supply Market Parameters: ", supplyMarketParams);

  console.log(`
    Summary:
    - This script will reallocate liquidity from multiple markets to a single market
    - Using the Morpho Blue API to fetch market data
    - Using the Bundler contract to execute the reallocation
  `);

  // Reallocation Summary
  console.log(`
    Reallocation Summary:
    - Requested Liquidity: ${summary.requestedLiquidity.toString()}
    - Available Liquidity in Target Market: ${marketData.state.liquidityAssets}
    - Total Reallocated from Source Markets: ${summary.totalReallocated.toString()}
    - Total Liquidity Provided: ${summary.totalLiquidityProvided.toString()}
  `);

  if (summary.isLiquidityFullyMatched) {
    console.log(
      `All requested liquidity has been successfully reallocated. \n`
    );
  } else {
    console.log(
      `Note: The requested liquidity could not be fully reallocated due to insufficient available liquidity in source markets.`
    );
    console.log(
      `Liquidity Shortfall: ${summary.liquidityShortfall.toString()}\n`
    );
  }

  const multicallInterface = BaseBundlerV2__factory.createInterface();

  //@ts-ignore
  const payload = multicallInterface.encodeFunctionData("multicall", [
    Object.keys(withdrawalsPerVault).map((vaultAddress) => {
      return BundlerAction.metaMorphoReallocateTo(
        publicAllocatorAddress,
        vaultAddress,
        0n, // Fee is zero as of today
        withdrawalsPerVault[vaultAddress].sort((a, b) =>
          getMarketId(a.marketParams).localeCompare(getMarketId(b.marketParams))
        ),
        supplyMarketParams
      );
    }),
  ]);

  console.log(payload);

  const rawTransaction = {
    to: BASE_BUNDLER_V2_ADDRESS,
    data: payload,
    value: "0",
  };

  await fs.promises.writeFile(
    "rawTransaction.json",
    JSON.stringify(rawTransaction, null, 2)
  );

  console.log(`
    Raw transaction JSON has been created and saved as 'rawTransaction.json'.
  `);
};

/* START HERE */
/*

Careful, the following addresses are hardcoded and should be manually retrieved and verified before running the script.
1. chainId of the network you expect to move liquidity into
2. marketId of the market you expect the borrowers to borrow from, executing the safeTx will bring available liquidity in this market.
*/

const BASE_BUNDLER_V2_ADDRESS = "0x4095F064B8d3c3548A3bebfd0Bbfd04750E30077";
const chainId = 1;
const marketId =
  "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
const liquidity = BigInt("1289482554257745308438"); // Replace with the desired liquidity amount

/* Let's query the API and form the tx that one should execute */
reallocateTo(marketId, chainId, liquidity);
