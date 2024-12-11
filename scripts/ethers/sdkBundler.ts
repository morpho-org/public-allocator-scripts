import { formatUnits, JsonRpcProvider } from "ethers";
import fs from "fs";
import "dotenv/config";

import {
  ChainAddresses,
  getChainAddresses,
  Market,
  MarketId,
  MarketParams,
  MathLib,
} from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-ethers/lib/augment";
import { LiquidityLoader } from "@morpho-org/liquidity-sdk-ethers";
import { BaseBundlerV2__factory } from "@morpho-org/morpho-blue-bundlers/types";
import { BundlerAction } from "@morpho-org/morpho-blue-bundlers/pkg";
import {
  MaybeDraft,
  PublicReallocation,
  SimulationState,
} from "@morpho-org/simulation-sdk";
import { format, Time } from "@morpho-org/morpho-ts";

interface Withdrawal {
  marketParams: MarketParams;
  amount: bigint;
}

/**
 * Initializes the provider and liquidity loader for a specific chain
 * @param chainId - The blockchain network identifier
 * @returns Object containing initialized provider, chain configuration, and liquidity loader
 * @throws Error if RPC URL is not configured or chain is unsupported
 */
async function initializeProviderAndLoader(chainId: number) {
  // Use the appropriate RPC URL based on chain ID
  const rpcUrl =
    chainId === 1
      ? process.env.RPC_URL_MAINNET
      : chainId === 8453
      ? process.env.RPC_URL_BASE
      : undefined;

  if (!rpcUrl)
    throw new Error(`No RPC URL configured for chain ID: ${chainId}`);

  const provider = new JsonRpcProvider(rpcUrl);
  const config = getChainAddresses(chainId);
  if (!config) throw new Error(`Unsupported chain ID: ${chainId}`);
  return { provider, config, loader: new LiquidityLoader(provider) };
}

// For displaying metrics across multiple markets efficiently, use the API
const API_URL = "https://blue-api.morpho.org/graphql";
const MARKET_QUERY = `
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
    }
  }
`;

/**
 * Fetches market metrics from the Morpho Blue API
 * @param marketId - The unique identifier of the market
 * @param chainId - The blockchain network identifier
 * @returns Object containing current market liquidity and reallocatable liquidity
 * @throws Error if market data is not found
 */
async function fetchMarketMetricsFromAPI(marketId: MarketId, chainId: number) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: MARKET_QUERY,
      variables: { uniqueKey: marketId, chainId },
    }),
  });

  const data: any = await response.json();
  const marketData = data?.data?.marketByUniqueKey;

  if (!marketData) throw new Error("Market data not found");

  return {
    currentMarketLiquidity: BigInt(marketData.state.liquidityAssets),
    reallocatableLiquidity: marketData.reallocatableLiquidityAssets,
  };
}

/**
 * Fetches market data using the liquidity loader
 * @param loader - The LiquidityLoader instance
 * @param marketId - The unique identifier of the market
 * @returns Object containing RPC data and boolean indicating presence of reallocatable liquidity
 */
async function fetchMarketData(loader: LiquidityLoader, marketId: MarketId) {
  const rpcData = await loader.fetch(marketId);
  return {
    rpcData,
    hasReallocatableLiquidity: rpcData.withdrawals.length > 0,
  };
}

/**
 * Calculates various liquidity metrics for a market
 * @param withdrawals - Array of public reallocations
 * @param requestedLiquidity - The amount of liquidity requested
 * @param currentMarketLiquidity - Current available liquidity in the market
 * @returns Object containing current market liquidity, reallocatable liquidity, and needed liquidity from reallocation
 */
function calculateLiquidityMetrics(
  withdrawals: PublicReallocation[],
  requestedLiquidity: bigint,
  currentMarketLiquidity: bigint
) {
  // Total liquidity that can be reallocated from other markets
  const reallocatableLiquidity = withdrawals.reduce(
    (acc, curr) => acc + curr.assets,
    0n
  );

  // If requested liquidity is more than what's currently in the market
  const liquidityNeededFromReallocation =
    requestedLiquidity > currentMarketLiquidity
      ? requestedLiquidity - currentMarketLiquidity
      : 0n;

  return {
    currentMarketLiquidity,
    reallocatableLiquidity,
    liquidityNeededFromReallocation,
  };
}

/**
 * Simulates market states and APY changes after reallocation and potential borrow
 * This is particularly useful for integrators who need to:
 * 1. Preview the market state after reallocation but before borrowing
 * 2. Estimate the APY impact of their planned borrow
 * 3. Verify the total reallocated amount
 *
 * @param rpcData The RPC data containing start and end states
 * @param marketId The target market ID
 * @param requestedLiquidity The amount user wants to borrow
 * @returns Simulation results including states and metrics
 */
function simulateMarketStates(
  rpcData: {
    startState: SimulationState;
    endState: MaybeDraft<SimulationState>;
    withdrawals: PublicReallocation[];
    targetBorrowUtilization: bigint;
  },
  marketId: MarketId,
  requestedLiquidity: bigint
) {
  // Get market states before and after reallocation
  const marketInitial = rpcData.startState.getMarket(marketId);
  const marketSimulated = rpcData.endState.getMarket(marketId);

  // Calculate how much liquidity was added through reallocation
  const reallocatedAmount = marketSimulated.liquidity - marketInitial.liquidity;

  // Simulate the borrow impact
  const borrowAmount = MathLib.min(
    requestedLiquidity,
    marketSimulated.liquidity
  );
  const { market: marketPostBorrow } = marketSimulated.borrow(
    borrowAmount,
    0n,
    Time.timestamp()
  );

  // Return comprehensive simulation results
  return {
    preReallocation: {
      liquidity: marketInitial.liquidity,
      borrowApy: marketInitial.borrowApy,
    },
    postReallocation: {
      liquidity: marketSimulated.liquidity,
      borrowApy: marketSimulated.borrowApy,
      reallocatedAmount,
    },
    postBorrow: {
      liquidity: marketPostBorrow.liquidity,
      borrowApy: marketPostBorrow.borrowApy,
      borrowAmount,
    },
  };
}

/**
 * Displays formatted simulation results to console
 * @param results - Results from market state simulation
 * @param decimals - Token decimals for formatting
 * @param priceUsd - Token price in USD for value calculation
 */
function displaySimulationResults(
  results: ReturnType<typeof simulateMarketStates>,
  decimals: number,
  priceUsd: number
) {
  console.log("\n=== Market State Simulation (Optional) ===");
  console.log("Initial State (Pre-Reallocation):");
  console.log(
    `- Liquidity: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(formatUnits(results.preReallocation.liquidity, decimals)) *
          priceUsd
      )}`
  );
  console.log(
    `- Borrow APY: ${format.number
      .digits(2)
      .unit("%")
      .of(Number(formatUnits(results.preReallocation.borrowApy, 16)))}%`
  );

  console.log("\nPost-Reallocation State:");
  console.log(
    `- Liquidity: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(formatUnits(results.postReallocation.liquidity, decimals)) *
          priceUsd
      )}`
  );
  console.log(
    `- Amount Reallocated: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(
          formatUnits(results.postReallocation.reallocatedAmount, decimals)
        ) * priceUsd
      )}`
  );
  console.log(
    `- Borrow APY: ${format.number
      .digits(2)
      .unit("%")
      .of(Number(formatUnits(results.postReallocation.borrowApy, 16)))}%`
  );

  console.log("\nPost-Borrow Simulation:");
  console.log(
    `- Remaining Liquidity: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(formatUnits(results.postBorrow.liquidity, decimals)) * priceUsd
      )}`
  );
  console.log(
    `- Borrow Amount: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(formatUnits(results.postBorrow.borrowAmount, decimals)) *
          priceUsd
      )}`
  );
  console.log(
    `- New Borrow APY: ${format.number
      .digits(2)
      .unit("%")
      .of(Number(formatUnits(results.postBorrow.borrowApy, 16)))}`
  );
}

/**
 * Logs a summary of the reallocation process
 * @param requestedLiquidity - Amount of liquidity requested
 * @param availableLiquidity - Currently available liquidity
 * @param totalReallocated - Total amount reallocated from other markets
 * @param decimals - Token decimals for formatting
 * @param priceUsd - Token price in USD for value calculation
 */
function logReallocationSummary(
  requestedLiquidity: bigint,
  availableLiquidity: bigint,
  totalReallocated: bigint,
  decimals: number,
  priceUsd: number
) {
  const isLiquidityFullyMatched =
    availableLiquidity + totalReallocated >= requestedLiquidity;
  const liquidityShortfall = isLiquidityFullyMatched
    ? 0n
    : requestedLiquidity - (availableLiquidity + totalReallocated);

  console.log(`
    Reallocation Summary:
    - Requested Liquidity: ${format.number
      .digits(2)
      .unit("$")
      .of(Number(formatUnits(requestedLiquidity, decimals)) * Number(priceUsd))}
    - Available Liquidity in Target Market: ${format.number
      .digits(2)
      .unit("$")
      .of(Number(formatUnits(availableLiquidity, decimals)) * Number(priceUsd))}
    - Total Reallocated from Source Markets: ${format.number
      .digits(2)
      .unit("$")
      .of(Number(formatUnits(totalReallocated, decimals)) * Number(priceUsd))}
    - Total Liquidity Provided: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(formatUnits(availableLiquidity + totalReallocated, decimals)) *
          Number(priceUsd)
      )}
  `);

  if (!isLiquidityFullyMatched) {
    console.log(
      `Liquidity Shortfall: ${format.number
        .digits(2)
        .unit("$")
        .of(
          Number(formatUnits(liquidityShortfall, decimals)) * Number(priceUsd)
        )}`
    );
  }
}

/**
 * Processes withdrawals and groups them by vault
 * @param withdrawals - Array of public reallocations
 * @param liquidityNeeded - Amount of liquidity needed from reallocation
 * @returns Object containing withdrawals grouped by vault and total reallocated amount
 */
function processWithdrawals(
  withdrawals: PublicReallocation[],
  liquidityNeeded: bigint
): {
  withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] };
  totalReallocated: bigint;
} {
  const withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] } = {};
  let totalReallocated = 0n;
  let remainingLiquidityNeeded = liquidityNeeded;

  // Group assets by vault
  const vaultTotalAssets = withdrawals.reduce(
    (acc: { [key: string]: bigint }, item) => {
      acc[item.vault] = (acc[item.vault] || 0n) + item.assets;
      return acc;
    },
    {}
  );

  // Sort vaults by total assets
  const sortedVaults = Object.entries(vaultTotalAssets).sort(
    ([, a], [, b]) => Number(b) - Number(a)
  );

  for (const [vaultAddress] of sortedVaults) {
    if (remainingLiquidityNeeded <= 0n) break;

    const vaultAllocations = withdrawals.filter(
      (item) => item.vault === vaultAddress
    );
    for (const allocation of vaultAllocations) {
      if (remainingLiquidityNeeded <= 0n) break;

      const amountToTake =
        allocation.assets < remainingLiquidityNeeded
          ? allocation.assets
          : remainingLiquidityNeeded;

      remainingLiquidityNeeded -= amountToTake;
      totalReallocated += amountToTake;

      if (!withdrawalsPerVault[vaultAddress]) {
        withdrawalsPerVault[vaultAddress] = [];
      }
      withdrawalsPerVault[vaultAddress].push({
        marketParams: MarketParams.get(allocation.id as MarketId),
        amount: amountToTake,
      });
    }
  }

  return { withdrawalsPerVault, totalReallocated };
}

/**
 * Creates and saves a transaction for reallocation
 * @param config - Chain-specific addresses configuration
 * @param withdrawalsPerVault - Object containing withdrawals grouped by vault
 * @param supplyMarketParams - Market parameters for the supply target
 * @returns Promise that resolves when transaction is saved
 */
async function createAndSaveTransaction(
  config: ChainAddresses,
  withdrawalsPerVault: { [vaultAddress: string]: Withdrawal[] },
  supplyMarketParams: MarketParams
) {
  const multicallInterface = BaseBundlerV2__factory.createInterface();
  const payload = multicallInterface.encodeFunctionData("multicall", [
    Object.keys(withdrawalsPerVault).map((vaultAddress) => {
      return BundlerAction.metaMorphoReallocateTo(
        config.publicAllocator,
        vaultAddress,
        0n,
        withdrawalsPerVault[vaultAddress].sort((a, b) =>
          a.marketParams.id.localeCompare(b.marketParams.id)
        ),
        supplyMarketParams
      );
    }),
  ]);

  const rawTransaction = {
    to: config.bundler,
    data: payload,
    value: "0",
  };

  await fs.promises.writeFile(
    "rawTransaction.json",
    JSON.stringify(rawTransaction, null, 2)
  );
  console.log(rawTransaction);
}

/**
 * Main function to compare available liquidity and perform reallocation if needed
 * @param marketId - The unique identifier of the target market
 * @param chainId - The blockchain network identifier
 * @param requestedLiquidity - Amount of liquidity requested
 * @param decimals - Token decimals for formatting
 * @param priceUsd - Token price in USD for value calculation
 * @throws Error if reallocation process fails
 */
async function compareAndReallocate(
  marketId: MarketId,
  chainId: number,
  requestedLiquidity: bigint,
  decimals: number,
  priceUsd: number
) {
  console.log("\n=== Starting compareAndReallocate ===");
  console.log(
    `Requested Liquidity: ${format.number
      .digits(2)
      .unit("$")
      .of(
        Number(formatUnits(requestedLiquidity, decimals)) * Number(priceUsd)
      )}`
  );

  // Initialize
  const { provider, config, loader } = await initializeProviderAndLoader(
    chainId
  );

  try {
    const {
      currentMarketLiquidity: availableLiquidityAPI,
      reallocatableLiquidity: reallocatableLiquidityAPI,
    } = await fetchMarketMetricsFromAPI(marketId, chainId);

    console.log(
      `- Current Market Liquidity API: ${format.number
        .digits(2)
        .unit("$")
        .of(
          Number(formatUnits(availableLiquidityAPI, decimals)) *
            Number(priceUsd)
        )}`
    );
    console.log(
      `- Reallocatable Liquidity API: ${format.number
        .digits(2)
        .unit("$")
        .of(
          Number(formatUnits(reallocatableLiquidityAPI, decimals)) *
            Number(priceUsd)
        )}`
    );
    // First check current market liquidity
    const market = await Market.fetch(marketId, provider);
    const currentMarketLiquidity = market.liquidity;

    console.log(
      `- Current Market Liquidity: ${format.number
        .digits(2)
        .unit("$")
        .of(
          Number(formatUnits(currentMarketLiquidity, decimals)) *
            Number(priceUsd)
        )}`
    );

    // Early return if we have enough liquidity already
    if (currentMarketLiquidity >= requestedLiquidity) {
      console.log(
        "\n✓ No reallocation needed - sufficient liquidity already available in target market"
      );
      console.log(
        `- Excess Liquidity: ${format.number
          .digits(2)
          .unit("$")
          .of(
            Number(
              formatUnits(currentMarketLiquidity - requestedLiquidity, decimals)
            ) * Number(priceUsd)
          )}`
      );
      return;
    }

    // Only fetch reallocatable liquidity if we need more
    const { rpcData, hasReallocatableLiquidity } = await fetchMarketData(
      loader,
      marketId
    );

    if (hasReallocatableLiquidity) {
      const simulationResults = simulateMarketStates(
        rpcData,
        marketId,
        requestedLiquidity
      );
      displaySimulationResults(simulationResults, decimals, priceUsd);
    }

    if (!hasReallocatableLiquidity) {
      console.log(
        "\n⚠ No available liquidity to reallocate from source markets"
      );
      console.log(
        `Liquidity Shortfall: ${format.number
          .digits(2)
          .unit("$")
          .of(
            Number(
              formatUnits(requestedLiquidity - currentMarketLiquidity, decimals)
            ) * Number(priceUsd)
          )}`
      );
      return;
    }

    // Continue with the rest of the function only if we have reallocatable liquidity
    const { reallocatableLiquidity, liquidityNeededFromReallocation } =
      calculateLiquidityMetrics(
        rpcData.withdrawals,
        requestedLiquidity,
        currentMarketLiquidity
      );

    console.log(
      `- Available Liquidity to Reallocate: ${format.number
        .digits(2)
        .unit("$")
        .of(
          Number(formatUnits(reallocatableLiquidity, decimals)) *
            Number(priceUsd)
        )}`
    );
    console.log(
      `- Needed from Reallocation: ${format.number
        .digits(2)
        .unit("$")
        .of(
          Number(formatUnits(liquidityNeededFromReallocation, decimals)) *
            Number(priceUsd)
        )}`
    );

    // Early return if no reallocation needed
    if (liquidityNeededFromReallocation === 0n) {
      console.log(
        "\nNo reallocation needed - sufficient liquidity already available in target market"
      );
      return;
    }

    // Process withdrawals
    const { withdrawalsPerVault, totalReallocated } = processWithdrawals(
      rpcData.withdrawals,
      liquidityNeededFromReallocation
    );
    console.log(
      `- Number of vaults involved: ${Object.keys(withdrawalsPerVault).length}`
    );
    console.log(`- Total reallocated amount: ${totalReallocated.toString()}`);

    // Log detailed withdrawal information
    console.log("\nDetailed withdrawal information:");
    Object.entries(withdrawalsPerVault).forEach(([vault, withdrawals]) => {
      console.log(`\nVault: ${vault}`);
      withdrawals.forEach((w, i) => {
        console.log(`  ${i + 1}. Market: ${w.marketParams.id}`);
        console.log(`     Amount: ${w.amount.toString()}`);
      });
    });

    // Log summary
    logReallocationSummary(
      requestedLiquidity,
      currentMarketLiquidity,
      totalReallocated,
      decimals,
      priceUsd
    );

    // Create and save transaction
    const supplyMarketParams = MarketParams.get(marketId);
    await createAndSaveTransaction(
      config,
      withdrawalsPerVault,
      supplyMarketParams
    );

    console.log("✓ Raw transaction saved to rawTransaction.json");
  } catch (error) {
    console.log("\nERROR IN REALLOCATION PROCESS");
    if (error instanceof Error) {
      console.error(`Error type: ${error.constructor.name}`);
      console.error(`Error message: ${error.message}`);
      console.error(`Stack trace: ${error.stack}`);
    } else {
      console.error("Unknown error type:", error);
    }
    throw error;
  }
}

// Example usage
const marketId =
  "0x3a4048c64ba1b375330d376b1ce40e4047d03b47ab4d48af484edec9fec801ba" as MarketId;
const chainId = 8453;
const REQUESTED_LIQUIDITY = BigInt("23000000000000000000000");

const decimals = 18; // only for display
const priceUsd = 3500; // only for display

compareAndReallocate(
  marketId,
  chainId,
  REQUESTED_LIQUIDITY,
  decimals,
  priceUsd
).catch(console.error);
