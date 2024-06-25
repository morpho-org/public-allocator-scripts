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
 * @return An object containing withdrawals grouped by vault and supply market parameters.
 */
const extractDataForReallocation = (marketData: any) => {
  const withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] } = {};

  marketData.publicAllocatorSharedLiquidity.forEach((item: any) => {
    const withdrawal: Withdrawal = {
      marketParams: {
        loanToken: item.allocationMarket.loanAsset.address,
        collateralToken: item.allocationMarket.collateralAsset.address,
        oracle: item.allocationMarket.oracle.address,
        irm: item.allocationMarket.irmAddress,
        lltv: item.allocationMarket.lltv,
      },
      amount: BigInt(item.assets),
    };

    if (!withdrawalsPerVault[item.vault.address]) {
      withdrawalsPerVault[item.vault.address] = [];
    }

    withdrawalsPerVault[item.vault.address].push(withdrawal);
  });

  const supplyMarketParams: MarketParams = {
    loanToken: marketData.loanAsset.address,
    collateralToken: marketData.collateralAsset.address,
    oracle: marketData.oracle.address,
    irm: marketData.irmAddress,
    lltv: marketData.lltv,
  };

  return { withdrawalsPerVault, supplyMarketParams };
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
 */
const reallocateTo = async (marketId: string, chainId: number) => {
  console.log(`
    Starting reallocation process...`);

  const publicAllocatorAddress = await queryPublicAllocatorAddress(chainId);
  if (!publicAllocatorAddress)
    throw new Error(`Public Allocator Address not found.`);

  console.log(`
    Public Allocator Address: ${publicAllocatorAddress}`);

  const marketData = await queryMarketData(marketId, chainId);
  if (!marketData) throw new Error("Market data not found.");

  const { withdrawalsPerVault, supplyMarketParams } =
    extractDataForReallocation(marketData);

  console.log(
    `
    Withdrawals by Vault: `,
    withdrawalsPerVault
  );

  console.log("Supply Market Parameters: ", supplyMarketParams);

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
const API_URL = "https://blue-api.morpho.org/graphql";
const chainId = 1;
const marketId =
  "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";

/* Let's query the API and form the tx that one should execute */
reallocateTo(marketId, chainId);
