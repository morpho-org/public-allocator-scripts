/* The following code is using:
1. The blue-api to fetch data from the Morpho API.
2. The PublicAllocator contract to reallocate liquidity.
3. The TxBuilder to cretae the json to batch.
*/

import { ethers, AbiCoder, keccak256 } from "ethers";
import "dotenv/config";
import fs from "fs";
import { TxBuilder } from "@morpho-labs/gnosis-tx-builder";
import { PublicAllocator__factory } from "ethers-types";

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
    Starting the creation of the public reallocation process...`);

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
  // Display all market params from the vault
  Object.entries(withdrawalsPerVault).forEach(([vaultAddress, withdrawals]) => {
    console.log(`
    Vault Address: ${vaultAddress}`);
    withdrawals.forEach((withdrawal, index) => {
      console.log(`
        Withdrawal ${index + 1}:`);
      console.log(`  Loan Token: ${withdrawal.marketParams.loanToken}`);
      console.log(
        `  Collateral Token: ${withdrawal.marketParams.collateralToken}`
      );
      console.log(`  Oracle: ${withdrawal.marketParams.oracle}`);
      console.log(`  IRM: ${withdrawal.marketParams.irm}`);
      console.log(`  LLTV: ${withdrawal.marketParams.lltv.toString()}`);
      console.log(`  Amount: ${withdrawal.amount.toString()}`);
    });
  });
  console.log(
    `
    Supply Market Parameters: `,
    supplyMarketParams
  );
  const iface = new ethers.Interface(PublicAllocator__factory.abi);

  const transactions = Object.keys(withdrawalsPerVault).map((vaultAddress) => ({
    to: publicAllocatorAddress,
    value: "0", // Fee being equal to zero as of today
    data: iface.encodeFunctionData("reallocateTo", [
      vaultAddress,
      withdrawalsPerVault[vaultAddress].sort((a, b) =>
        getMarketId(a.marketParams).localeCompare(getMarketId(b.marketParams))
      ),
      supplyMarketParams,
    ]),
  }));

  const batchJson = TxBuilder.batch(SAFE_ADDRESS, transactions);

  await fs.promises.writeFile(
    "safeBatch.json",
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
  "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";

const SAFE_ADDRESS = "0xD81E0983e8e133d34670728406d08637374e545D"; // The safe address you are expecting to execute with

/* Let's query the API and form the tx that one should execute */
reallocateTo(marketId, chainId);
