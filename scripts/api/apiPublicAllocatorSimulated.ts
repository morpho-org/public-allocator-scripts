// External dependencies
import {
  createPublicClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import "dotenv/config";

// Morpho dependencies
import { BaseBundlerV2__factory } from "@morpho-org/morpho-blue-bundlers/types";
import { BundlerAction } from "@morpho-org/morpho-blue-bundlers/pkg";
import { mainnet, base } from "viem/chains";

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
  loanToken: `0x${string}`;
  collateralToken: `0x${string}`;
  oracle: `0x${string}`;
  irm: `0x${string}`;
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

// Define valid chain IDs
type SupportedChainId = 1 | 8453;

// Constants
const API_URL = "https://blue-api.morpho.org/graphql" as const;
const BASE_BUNDLER_V2_ADDRESS: Readonly<
  Record<SupportedChainId, `0x${string}`>
> = {
  1: "0x4095F064B8d3c3548A3bebfd0Bbfd04750E30077",
  8453: "0x23055618898e202386e6c13955a58D3C68200BFB",
} as const;

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
          decimals
          priceUsd
        }
        collateralAsset {
          address
          decimals
          priceUsd
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

// Add this interface before the simulateSingleReallocation function
interface SimulationResult {
  success: boolean;
  vaultAddress: `0x${string}`;
  withdrawals: Withdrawal[];
  result?: unknown;
  error?: string;
}

/**
 * @notice Initialize the viem client
 * @param chainId The chain ID
 * @return The initialized viem client
 */
async function initializeClient(chainId: SupportedChainId) {
  const rpcUrl =
    chainId === 1
      ? process.env.RPC_URL_MAINNET
      : chainId === 8453
      ? process.env.RPC_URL_BASE
      : undefined;

  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for chain ID: ${chainId}`);
  }

  const client = createPublicClient({
    chain: chainId === 1 ? mainnet : base,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 1000,
      timeout: 20000,
      batch: {
        batchSize: 100,
        wait: 20,
      },
    }),
    batch: {
      multicall: {
        batchSize: 2048,
        wait: 50,
      },
    },
  });
  return { client };
}

/**
 * @notice Helper function to fetch data from the Morpho API.
 * @param query The GraphQL query string.
 * @param variables Optional variables for the query.
 * @return The JSON response from the API.
 */
export const fetchAPI = async <T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> => {
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
        loanToken: item.allocationMarket.loanAsset.address as `0x${string}`,
        collateralToken:
          item.allocationMarket.collateralAsset?.address || zeroAddress,
        oracle: item.allocationMarket.oracle?.address || zeroAddress,
        irm: item.allocationMarket.irmAddress || zeroAddress,
        lltv: item.allocationMarket.lltv,
      },
      amount: BigInt(item.assets), // a 99% buffer can be added here with BigInt(item.assets) * BigInt(99) / BigInt(100)
    };

    if (!withdrawalsPerVault[item.vault.address]) {
      withdrawalsPerVault[item.vault.address] = [];
    }

    withdrawalsPerVault[item.vault.address].push(withdrawal);
  });

  const supplyMarketParams: MarketParams = {
    loanToken: marketData.loanAsset.address as `0x${string}`,
    collateralToken: marketData.collateralAsset.address as `0x${string}`,
    oracle: marketData.oracle.address as `0x${string}`,
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
  const encodedMarket = encodeAbiParameters(
    parseAbiParameters("address, address, address, address, uint256"),
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
 * @notice Process withdrawals until reaching the required amount or exhausting available withdrawals
 * @param withdrawalsPerVault - Object mapping vault addresses to their respective withdrawals
 * @param liquidityToReallocate - Target amount of liquidity to reallocate
 * @returns Object containing processed withdrawals and status information
 */
const processWithdrawals = (
  withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] },
  liquidityToReallocate: bigint
): {
  processedWithdrawals: { [vaultAddress: string]: Withdrawal[] };
  totalReallocated: bigint;
  remainingLiquidity: bigint;
  isLiquidityFullyMatched: boolean;
} => {
  const processedWithdrawals: { [vaultAddress: string]: Withdrawal[] } = {};
  let remainingLiquidity = liquidityToReallocate;
  let totalReallocated = BigInt(0);

  // Process each vault's withdrawals
  for (const [vaultAddress, withdrawals] of Object.entries(
    withdrawalsPerVault
  )) {
    if (remainingLiquidity <= BigInt(0)) break; // Stop if we've met our target

    processedWithdrawals[vaultAddress] = [];

    // Process withdrawals for this vault
    for (const withdrawal of withdrawals) {
      if (remainingLiquidity <= BigInt(0)) break; // Stop if we've met our target

      const amountToWithdraw =
        withdrawal.amount > remainingLiquidity
          ? remainingLiquidity
          : withdrawal.amount;

      processedWithdrawals[vaultAddress].push({
        marketParams: withdrawal.marketParams,
        amount: amountToWithdraw,
      });

      totalReallocated += amountToWithdraw;
      remainingLiquidity -= amountToWithdraw;
    }

    // Remove vault if no withdrawals were processed
    if (processedWithdrawals[vaultAddress].length === 0) {
      delete processedWithdrawals[vaultAddress];
    }
  }

  return {
    processedWithdrawals,
    totalReallocated,
    remainingLiquidity,
    isLiquidityFullyMatched: remainingLiquidity <= 0n,
  };
};

/**
 * @notice Simulates reallocation actions individually for each withdrawal
 * @param client The initialized viem client
 * @param bundlerAddress The address of the bundler contract
 * @param publicAllocatorAddress The address of the public allocator
 * @param withdrawalsPerVault Object containing withdrawals grouped by vault
 * @param supplyMarketParams The market parameters for supply
 * @return Array of simulation results
 */
async function simulateIndividualReallocations(
  client: any,
  bundlerAddress: `0x${string}`,
  publicAllocatorAddress: string,
  withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] },
  supplyMarketParams: MarketParams,
  simulationAccount?: `0x${string}`
): Promise<SimulationResult[]> {
  const results: SimulationResult[] = [];

  // Iterate through each vault and its withdrawals
  for (const [vaultAddress, withdrawals] of Object.entries(
    withdrawalsPerVault
  )) {
    // Simulate each withdrawal individually for this vault
    for (const withdrawal of withdrawals) {
      try {
        // Create bundler actions array for this withdrawal
        const bundlerActions = [
          BundlerAction.metaMorphoReallocateTo(
            publicAllocatorAddress,
            vaultAddress,
            0n,
            [withdrawal], // Single withdrawal
            supplyMarketParams
          ),
        ];

        const accountToUse =
          simulationAccount ??
          ("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`);

        // Simulate the contract interaction
        const { result } = await client.simulateContract({
          address: bundlerAddress,
          abi: BaseBundlerV2__factory.abi,
          functionName: "multicall",
          args: [bundlerActions],
          account: accountToUse,
        });

        results.push({
          success: true,
          vaultAddress: vaultAddress as `0x${string}`,
          withdrawals: [withdrawal],
          result,
        });
      } catch (error) {
        results.push({
          success: false,
          vaultAddress: vaultAddress as `0x${string}`,
          withdrawals: [withdrawal],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}

/**
 * @notice Main function to execute the reallocation process and create transaction JSON.
 * @param marketId The ID of the market to reallocate to.
 * @param chainId The ID of the blockchain network.
 * @param requestedLiquidityNativeUnits The amount of liquidity requested in native units
 */
const reallocateRequestedLiquidity = async (
  marketId: string,
  chainId: SupportedChainId,
  requestedLiquidityNativeUnits: number
) => {
  console.log(`
      Asked for ${requestedLiquidityNativeUnits} of Loan Asset`);

  const publicAllocatorAddress = await queryPublicAllocatorAddress(chainId);
  if (!publicAllocatorAddress)
    throw new Error(`Public Allocator Address not found.`);

  console.log(`
      Public Allocator Address: ${publicAllocatorAddress}`);

  const marketData = await queryMarketData(marketId, chainId);
  if (!marketData) throw new Error("Market data not found.");

  // Calculate liquidity to reallocate

  const liquidityToBeBorrowed =
    BigInt(requestedLiquidityNativeUnits) *
    BigInt(10 ** marketData.loanAsset.decimals);

  const currentMarketLiquidity = BigInt(marketData.state.liquidityAssets);

  if (liquidityToBeBorrowed < currentMarketLiquidity) {
    console.log(`
      No transactions generated as there is enough liquidity in market.
    `);
    return;
  }

  const liquidityToReallocate = liquidityToBeBorrowed - currentMarketLiquidity;

  console.log(`
      - Current market liquidity:        ${formatUnits(
        currentMarketLiquidity,
        marketData.loanAsset.decimals
      )}
      - Liquidity to be borrowed:        ${formatUnits(
        liquidityToBeBorrowed,
        marketData.loanAsset.decimals
      )}
      - Liquidity to reallocate:         ${formatUnits(
        liquidityToReallocate,
        marketData.loanAsset.decimals
      )}
      - Maximum liquidity reallocatable: ${formatUnits(
        marketData.reallocatableLiquidityAssets,
        marketData.loanAsset.decimals
      )}
      - Total Available Liquidity:       ${formatUnits(
        currentMarketLiquidity +
          BigInt(marketData.reallocatableLiquidityAssets),
        marketData.loanAsset.decimals
      )}
  `);

  const { withdrawalsPerVault, supplyMarketParams } =
    extractDataForReallocation(marketData);

  // let's make sure the data are right, by simulating individual reallocation, for all vaults & withdrawal. 1 by 1.

  console.log("\nSimulating individual withdrawals...");
  const { client } = await initializeClient(chainId);
  const simulationResults = await simulateIndividualReallocations(
    client,
    BASE_BUNDLER_V2_ADDRESS[chainId],
    publicAllocatorAddress,
    withdrawalsPerVault,
    supplyMarketParams
  );

  // Log simulation results
  console.log("\nSimulation Results:");
  simulationResults.forEach((result, index) => {
    console.log(`\nSimulation ${index + 1}:`);
    console.log(`Vault: ${result.vaultAddress}`);
    console.log(`Success: ${result.success ? "✅" : "❌"}`);
    if (!result.success) {
      console.log(`Error: ${result.error}`);
    }
  });

  // After simulations, add detailed reporting
  console.log("\nDetailed Simulation Results:");
  console.log("\nSuccessful Combinations:");
  simulationResults.forEach((result) => {
    if (result.success) {
      result.withdrawals.forEach((withdrawal) => {
        console.log(`
✅ Vault: ${result.vaultAddress}
   Market ID: ${getMarketId(withdrawal.marketParams)}
   Amount: ${withdrawal.amount}
   Loan Token: ${withdrawal.marketParams.loanToken}
   Collateral: ${withdrawal.marketParams.collateralToken}`);
      });
    }
  });

  console.log("\nFailed Combinations:");
  simulationResults.forEach((result) => {
    if (!result.success) {
      result.withdrawals.forEach((withdrawal) => {
        console.log(`
❌ Vault: ${result.vaultAddress}
   Market ID: ${getMarketId(withdrawal.marketParams)}
   Amount: ${withdrawal.amount}
   Loan Token: ${withdrawal.marketParams.loanToken}
   Collateral: ${withdrawal.marketParams.collateralToken}
   Error: ${result.error}`);
      });
    }
  });

  // Modify the filtering to keep successful withdrawals per vault
  const filteredWithdrawalsPerVault = Object.fromEntries(
    Object.entries(withdrawalsPerVault)
      .map(([vaultAddress, withdrawals]) => {
        // Filter only successful withdrawals for this vault
        const successfulWithdrawals = withdrawals.filter((withdrawal) => {
          return simulationResults.some(
            (result) =>
              result.vaultAddress === vaultAddress &&
              result.success &&
              result.withdrawals.some(
                (w) =>
                  getMarketId(w.marketParams) ===
                  getMarketId(withdrawal.marketParams)
              )
          );
        });
        return [vaultAddress, successfulWithdrawals];
      })
      .filter(([_, withdrawals]) => withdrawals.length > 0) // Remove vaults with no successful withdrawals
  );

  // Process withdrawals up to the required amount
  const { processedWithdrawals, totalReallocated, isLiquidityFullyMatched } =
    processWithdrawals(filteredWithdrawalsPerVault, liquidityToReallocate);

  console.log(
    `
      Processed withdrawals by vault: `,
    processedWithdrawals
  );
  console.log(`
      Total reallocated: ${totalReallocated}
      Target reached: ${isLiquidityFullyMatched ? "Yes" : "No"}`);

  if (!isLiquidityFullyMatched) {
    console.log(`
      Warning: Could not fully match requested liquidity. 
      Requested: ${liquidityToReallocate}
      Reallocated: ${totalReallocated}`);
  }

  // Only proceed with successful reconstructed withdrawals
  if (totalReallocated > 0n) {
    // Simulate the final transaction
    try {
      const simulationResult = await client.simulateContract({
        address: BASE_BUNDLER_V2_ADDRESS[chainId],
        abi: BaseBundlerV2__factory.abi,
        functionName: "multicall",
        args: [
          Object.keys(processedWithdrawals).map((vaultAddress) =>
            BundlerAction.metaMorphoReallocateTo(
              publicAllocatorAddress as `0x${string}`,
              vaultAddress as `0x${string}`,
              0n,
              processedWithdrawals[vaultAddress].sort((a, b) =>
                getMarketId(a.marketParams).localeCompare(
                  getMarketId(b.marketParams)
                )
              ),
              supplyMarketParams
            )
          ) as [`0x${string}`],
        ],
        account: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`,
        value: 0n,
      });

      console.log(`
      Final Transaction Simulation Successful ✅
      Estimated Gas: ${simulationResult.request.gas}
      We reallocated ${totalReallocated} liquidity to the market.
      `);
    } catch (error) {
      console.error(`
      Final Transaction Simulation Failed ❌
      Error: ${error instanceof Error ? error.message : String(error)}
      `);
    }
  } else {
    console.log(`
      No transactions generated as no liquidity was reallocated.
    `);
  }

  // Create validation table with proper alignment
  console.log("\n=== Validation Status ===");
  console.log(
    "\n| Vault Address      | Market ID          | Amount            |  API  | Simulation |"
  );
  console.log(
    "|--------------------|--------------------|--------------------|-------|------------|"
  );

  Object.entries(withdrawalsPerVault).forEach(([vaultAddress, withdrawals]) => {
    withdrawals.forEach((withdrawal) => {
      const simulationResult = simulationResults.find(
        (result) =>
          result.vaultAddress === vaultAddress &&
          result.withdrawals.some(
            (w) =>
              getMarketId(w.marketParams) ===
              getMarketId(withdrawal.marketParams)
          )
      );

      const shortVault = `${vaultAddress.slice(0, 10)}...${vaultAddress.slice(
        -4
      )}`;
      const shortMarketId = `${getMarketId(withdrawal.marketParams).slice(
        0,
        10
      )}...`;
      const amount = withdrawal.amount.toString().padEnd(18);

      console.log(
        `| ${shortVault.padEnd(18)} | ${shortMarketId.padEnd(
          18
        )} | ${amount} |  ✅  |     ${
          simulationResult?.success ? "✅" : "❌"
        }     |`
      );
    });
  });

  // Enhanced summary with proper alignment
  console.log("\n📊 REALLOCATION SUMMARY");
  console.log("═".repeat(80));

  // Market Details
  console.log("\n🏦 Market Information");
  console.log("─".repeat(80));
  console.log(`Market ID:      ${marketId}`);
  console.log(`Chain ID:       ${chainId}`);
  console.log(`Loan Token:     ${marketData.loanAsset.address}`);

  // Vault Details with proper table alignment
  console.log("\n🏛️  Vault Breakdown");
  console.log("─".repeat(80));
  console.log(
    "| Vault Address        | Markets | Total Amount        | Status |"
  );
  console.log("|--------------------|---------|--------------------|--------|");

  Object.entries(processedWithdrawals).forEach(
    ([vaultAddress, withdrawals]) => {
      const totalVaultAmount = withdrawals.reduce(
        (sum, w) => sum + w.amount,
        0n
      );
      const marketsCount = withdrawals.length.toString().padStart(7);
      const shortVault = `${vaultAddress.slice(0, 10)}...${vaultAddress.slice(
        -4
      )}`;
      const formattedAmount = formatUnits(
        totalVaultAmount,
        marketData.loanAsset.decimals
      ).padEnd(18);

      console.log(
        `| ${shortVault.padEnd(
          18
        )} | ${marketsCount} | ${formattedAmount} |   ✅   |`
      );
    }
  );

  // Final Notes
  if (!isLiquidityFullyMatched) {
    console.log("\n⚠️  Important Notes");
    console.log("─".repeat(80));
    console.log("Could not fully match requested liquidity:");
    console.log(
      `Missing: ${formatUnits(
        liquidityToReallocate - totalReallocated,
        marketData.loanAsset.decimals
      )} ${marketData.loanAsset.symbol || ""}`
    );
  }

  console.log("\n" + "═".repeat(80));
};

/* START HERE */
/* 
1. chainId of the network you expect to move liquidity into
2. marketId of the market you expect the borrowers to borrow from, executing the safeTx will bring available liquidity in this market.
3. requestedLiquidityNativeUnits: the amount of liquidity you want to move into the market
*/

const chainId = 8453 as SupportedChainId;
const marketId =
  "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
const requestedLiquidityNativeUnits = 20000000; // 20M USDC

/* Let's query the API and form the tx that one should execute to reallocate liquidity */
reallocateRequestedLiquidity(marketId, chainId, requestedLiquidityNativeUnits);
