// WIP work, do not change this file.

import { Address, createClient, http, parseEther } from "viem";
import {
  ChainId,
  getChainAddresses,
  Market,
  MarketId,
  MarketParams,
  MarketUtils,
  MathLib,
} from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";
import { LiquidityLoader } from "@morpho-org/liquidity-sdk-viem";
import { BaseBundlerV2__factory } from "@morpho-org/morpho-blue-bundlers/types";
import { BundlerAction } from "@morpho-org/morpho-blue-bundlers/pkg";
import { PublicReallocation } from "@morpho-org/simulation-sdk";
import { Time } from "@morpho-org/morpho-ts";
import { base, mainnet } from "viem/chains";
import {
  type MaybeDraft,
  type SimulationState,
  produceImmutable,
} from "@morpho-org/simulation-sdk";
import "dotenv/config";
/**
 * The default target utilization above which the shared liquidity algorithm is triggered (scaled by WAD).
 */
export const DEFAULT_SUPPLY_TARGET_UTILIZATION = 90_5000000000000000n;

interface VaultReallocation {
  id: MarketId;
  assets: bigint;
}

interface WithdrawalDetails {
  marketId: MarketId;
  marketParams: MarketParams;
  amount: bigint;
  sourceMarketLiquidity: bigint;
}

interface ProcessedWithdrawals {
  withdrawalsPerVault: { [vaultAddress: string]: WithdrawalDetails[] };
  totalReallocated: bigint;
}

interface MarketSimulationResult {
  preReallocation: {
    liquidity: bigint;
    borrowApy: bigint;
    utilization: bigint;
  };
  postReallocation: {
    liquidity: bigint;
    borrowApy: bigint;
    reallocatedAmount: bigint;
    utilization: bigint;
  };
}

interface SimulationResults {
  targetMarket: MarketSimulationResult & {
    postBorrow: {
      liquidity: bigint;
      borrowApy: bigint;
      borrowAmount: bigint;
      utilization: bigint;
    };
  };
  sourceMarkets: {
    [marketId: string]: MarketSimulationResult;
  };
}

interface Asset {
  address: string;
  symbol: string;
}

interface AllocationMarket {
  uniqueKey: string;
  collateralAsset: Asset;
  loanAsset: Asset;
  lltv: string;
  targetBorrowUtilization: string;
  targetWithdrawUtilization: string;
  state: {
    utilization: number;
  };
}

interface Vault {
  address: string;
  name: string;
}

interface SharedLiquidity {
  assets: string;
  vault: Vault;
  allocationMarket: AllocationMarket;
}

export interface ReallocationResult {
  requestedLiquidity: bigint;
  currentMarketLiquidity: bigint;
  apiMetrics: {
    currentMarketLiquidity: bigint;
    reallocatableLiquidity: bigint;
    decimals: number;
    priceUsd: number;
    symbol: string;
    loanAsset: {
      address: string;
      symbol: string;
    };
    collateralAsset: {
      address: string;
      symbol: string;
    };
    lltv: bigint;
    publicAllocatorSharedLiquidity: SharedLiquidity[];
    utilization: bigint;
    maxBorrowWithoutReallocation?: bigint;
  };
  simulation?: SimulationResults;
  reallocation?: {
    withdrawals: ProcessedWithdrawals;
    liquidityNeededFromReallocation: bigint;
    reallocatableLiquidity: bigint;
    isLiquidityFullyMatched: boolean;
    liquidityShortfall: bigint;
  };
  rawTransaction?: {
    to: string;
    data: string;
    value: string;
  };
  reason?: {
    type: "success" | "error";
    message: string;
  };
}

// For displaying metrics across multiple markets efficiently, use the API
const API_URL = "https://blue-api.morpho.org/graphql";
const MARKET_QUERY = `
query MarketByUniqueKeyReallocatable($uniqueKey: String!, $chainId: Int!) {
  marketByUniqueKey(uniqueKey: $uniqueKey, chainId: $chainId) {
    reallocatableLiquidityAssets
    publicAllocatorSharedLiquidity {
      assets
      vault {
        address
        name
      }
      allocationMarket {
        targetBorrowUtilization
        targetWithdrawUtilization
        state {
          utilization
        } 
        uniqueKey
        collateralAsset {
          address
          symbol
        }
        loanAsset {
          address
          symbol
        }
        lltv
      }
      
    }
    loanAsset {
      address
      decimals
      priceUsd
      symbol
    }
    collateralAsset {
      address
      decimals
      priceUsd
      symbol
    }
    lltv
    state {
      liquidityAssets
      utilization
    }
  }
}
`;

async function initializeClientAndLoader(chainId: number) {
  // Use the appropriate RPC URL based on chain ID
  const rpcUrl =
    chainId === 1
      ? process.env.RPC_URL_MAINNET
      : chainId === 8453
      ? process.env.RPC_URL_BASE
      : undefined;

  if (!rpcUrl)
    throw new Error(`No RPC URL configured for chain ID: ${chainId}`);

  const client = createClient({
    chain: chainId === 1 ? mainnet : chainId === 8453 ? base : mainnet,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 1000,
      timeout: 20000,
      batch: {
        // Only useful for Alchemy endpoints
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
  const config = getChainAddresses(chainId);
  if (!config) throw new Error(`Unsupported chain ID: ${chainId}`);
  return {
    client,
    config,
    loader: new LiquidityLoader(client, {
      maxWithdrawalUtilization: {},
      defaultMaxWithdrawalUtilization: parseEther("1"),
    }),
  };
}

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

  // Convert decimal utilization to WAD-scaled bigint
  const utilizationWad = BigInt(
    Math.floor(marketData.state.utilization * 1e18)
  );

  return {
    utilization: utilizationWad, // Now WAD-scaled
    currentMarketLiquidity: BigInt(marketData.state.liquidityAssets),
    reallocatableLiquidity: BigInt(marketData.reallocatableLiquidityAssets),
    decimals: marketData.loanAsset.decimals,
    priceUsd: marketData.loanAsset.priceUsd,
    symbol: marketData.loanAsset.symbol,
    loanAsset: marketData.loanAsset,
    collateralAsset: marketData.collateralAsset,
    lltv: marketData.lltv,
    publicAllocatorSharedLiquidity:
      marketData.publicAllocatorSharedLiquidity.map((item: any) => ({
        assets: item.assets,
        vault: item.vault,
        allocationMarket: item.allocationMarket,
      })),
  };
}

async function fetchMarketData(loader: LiquidityLoader, marketId: MarketId) {
  const rpcData = await loader.fetch(marketId);
  console.log(
    "Market data loader withdrawals retrieved: ",
    rpcData.withdrawals
  );
  return {
    rpcData,
    hasReallocatableLiquidity: rpcData.withdrawals.length > 0,
  };
}

function processReallocations(
  withdrawals: PublicReallocation[],
  requiredAssets: bigint
): { [vault: Address]: VaultReallocation[] } {
  const reallocations: { [vault: Address]: VaultReallocation[] } = {};

  for (const { vault, id, assets } of withdrawals) {
    // Initialize array for this vault if it doesn't exist
    if (!reallocations[vault]) {
      reallocations[vault] = [];
    }

    if (assets > requiredAssets) {
      // If this withdrawal can fulfill all remaining required assets
      reallocations[vault].push({
        id,
        assets: requiredAssets,
      });
      break;
    } else {
      // Add the full withdrawal amount and continue
      reallocations[vault].push({
        id,
        assets,
      });
      requiredAssets -= assets;
    }
  }

  return reallocations;
}

function simulateMarketStates(
  rpcData: {
    startState: SimulationState;
    endState: MaybeDraft<SimulationState>;
    withdrawals: PublicReallocation[];
    targetBorrowUtilization: bigint;
  },
  marketId: MarketId,
  requestedLiquidity: bigint,
  reallocations: { [vault: Address]: VaultReallocation[] }
): SimulationResults {
  // Create a new simulation state based on initial state
  const simulatedState = produceImmutable(rpcData.startState, (draft) => {
    // Process each reallocation

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [vault, vaultReallocations] of Object.entries(reallocations)) {
      for (const reallocation of vaultReallocations) {
        // Get source market
        const sourceMarket = draft.getMarket(reallocation.id);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const initialSourceState = {
          liquidity: sourceMarket.liquidity,
          borrowApy: sourceMarket.borrowApy,
          utilization: sourceMarket.utilization,
        };

        // Simulate withdrawal and capture new state
        const withdrawResult = sourceMarket.withdraw(reallocation.assets, 0n);

        // Replace market properties with new state
        Object.assign(sourceMarket, withdrawResult.market);

        // Get target market and track initial state
        const targetMarket = draft.getMarket(marketId);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const initialTargetState = {
          liquidity: targetMarket.liquidity,
          borrowApy: targetMarket.borrowApy,
          utilization: targetMarket.utilization,
        };

        // Simulate deposit and capture new state
        const supplyResult = targetMarket.supply(reallocation.assets, 0n);

        // Replace market properties with new state
        Object.assign(targetMarket, supplyResult.market);
      }
    }
  });

  // Get initial and final states for target market
  const marketInitial = rpcData.startState.getMarket(marketId);
  const marketSimulated = simulatedState.getMarket(marketId);
  const reallocatedAmount = marketSimulated.liquidity - marketInitial.liquidity;

  // Simulate borrow impact
  const borrowAmount = MathLib.min(
    requestedLiquidity,
    marketSimulated.liquidity
  );
  const borrowResult = marketSimulated.borrow(
    borrowAmount,
    0n,
    Time.timestamp()
  );

  // Update market with borrow result
  const marketPostBorrow = borrowResult.market;

  // Calculate metrics for source markets
  const sourceMarkets: { [marketId: string]: MarketSimulationResult } = {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [vault, vaultReallocations] of Object.entries(reallocations)) {
    for (const reallocation of vaultReallocations) {
      const sourceMarketInitial = rpcData.startState.getMarket(reallocation.id);
      const sourceMarketSimulated = simulatedState.getMarket(reallocation.id);

      sourceMarkets[reallocation.id] = {
        preReallocation: {
          liquidity: sourceMarketInitial.liquidity,
          borrowApy: sourceMarketInitial.borrowApy,
          utilization: sourceMarketInitial.utilization,
        },
        postReallocation: {
          liquidity: sourceMarketSimulated.liquidity,
          borrowApy: sourceMarketSimulated.borrowApy,
          reallocatedAmount: reallocation.assets,
          utilization: sourceMarketSimulated.utilization,
        },
      };
    }
  }

  return {
    targetMarket: {
      preReallocation: {
        liquidity: marketInitial.liquidity,
        borrowApy: marketInitial.borrowApy,
        utilization: marketInitial.utilization,
      },
      postReallocation: {
        liquidity: marketSimulated.liquidity,
        borrowApy: marketSimulated.borrowApy,
        reallocatedAmount,
        utilization: marketSimulated.utilization,
      },
      postBorrow: {
        liquidity: marketPostBorrow.liquidity,
        borrowApy: marketPostBorrow.borrowApy,
        borrowAmount,
        utilization: marketPostBorrow.utilization,
      },
    },
    sourceMarkets,
  };
}

export async function compareAndReallocate(
  marketId: MarketId,
  chainId: ChainId,
  requestedLiquidity: bigint
): Promise<ReallocationResult> {
  const result: ReallocationResult = {
    requestedLiquidity,
    currentMarketLiquidity: 0n,
    apiMetrics: {
      utilization: 0n,
      maxBorrowWithoutReallocation: 0n,
      currentMarketLiquidity: 0n,
      reallocatableLiquidity: 0n,
      decimals: 0,
      priceUsd: 0,
      symbol: "",
      loanAsset: { address: "", symbol: "" },
      collateralAsset: { address: "", symbol: "" },
      lltv: 0n,
      publicAllocatorSharedLiquidity: [],
    },
  };

  const { client, config, loader } = await initializeClientAndLoader(chainId);

  try {
    // First fetch API metrics to get decimals
    const [apiMetrics, market] = await Promise.all([
      fetchMarketMetricsFromAPI(marketId, chainId),
      Market.fetch(marketId, client),
    ]);

    result.apiMetrics = apiMetrics;
    result.currentMarketLiquidity = market.liquidity;

    // Scale the requested liquidity with the correct decimals
    const scaledRequestedLiquidity =
      requestedLiquidity * BigInt(10 ** apiMetrics.decimals);

    const supplyTargetUtilization = DEFAULT_SUPPLY_TARGET_UTILIZATION;
    const newTotalSupplyAssets = market.totalSupplyAssets;
    const newTotalBorrowAssets =
      market.totalBorrowAssets + scaledRequestedLiquidity;

    // Then the maximum additional borrow, to keep utilization ≤ supplyTargetUtilization:
    const maxAdditionalBorrow =
      MathLib.wMulUp(supplyTargetUtilization, newTotalSupplyAssets) -
      market.totalBorrowAssets;
    result.apiMetrics.maxBorrowWithoutReallocation = maxAdditionalBorrow;

    // Check if we need reallocation
    if (
      MarketUtils.getUtilization({
        totalSupplyAssets: newTotalSupplyAssets,
        totalBorrowAssets: newTotalBorrowAssets,
      }) > supplyTargetUtilization
    ) {
      // Calculate required assets for target utilization
      let requiredAssets =
        MathLib.wDivDown(newTotalBorrowAssets, supplyTargetUtilization) -
        newTotalSupplyAssets;

      const { rpcData, hasReallocatableLiquidity } = await fetchMarketData(
        loader,
        marketId
      );

      if (hasReallocatableLiquidity) {
        const reallocations = processReallocations(
          rpcData.withdrawals,
          requiredAssets
        );

        result.simulation = simulateMarketStates(
          rpcData,
          marketId,
          scaledRequestedLiquidity,
          reallocations
        );

        // Calculate total reallocated liquidity
        const totalReallocated = Object.values(reallocations).reduce(
          (total, vaultReallocations) =>
            total + vaultReallocations.reduce((sum, r) => sum + r.assets, 0n),
          0n
        );

        const isLiquidityFullyMatched =
          result.currentMarketLiquidity + totalReallocated >=
          scaledRequestedLiquidity;

        // Transform reallocations into withdrawal details
        const withdrawalsPerVault: {
          [vaultAddress: string]: WithdrawalDetails[];
        } = {};

        for (const [vault, vaultReallocations] of Object.entries(
          reallocations
        )) {
          withdrawalsPerVault[vault] = vaultReallocations.map(
            (reallocation) => ({
              marketId: reallocation.id,
              marketParams: MarketParams.get(reallocation.id),
              amount: reallocation.assets,
              sourceMarketLiquidity: rpcData.startState.getMarket(
                reallocation.id
              ).liquidity,
            })
          );
        }

        result.reallocation = {
          withdrawals: {
            withdrawalsPerVault,
            totalReallocated,
          },
          liquidityNeededFromReallocation: requiredAssets,
          reallocatableLiquidity: totalReallocated,
          isLiquidityFullyMatched,
          liquidityShortfall: isLiquidityFullyMatched
            ? 0n
            : scaledRequestedLiquidity -
              (result.currentMarketLiquidity + totalReallocated),
        };

        // Generate raw transaction if we have reallocations
        if (totalReallocated > 0n) {
          const supplyMarketParams = MarketParams.get(marketId);

          // Sort withdrawals by market id for consistency
          const sortedVaults = Object.keys(withdrawalsPerVault).sort();

          const multicallActions = sortedVaults.map((vaultAddress) => {
            const vaultWithdrawals = withdrawalsPerVault[vaultAddress];
            // Sort withdrawals within each vault
            vaultWithdrawals.sort((a, b) => (a.marketId > b.marketId ? 1 : -1));

            return BundlerAction.metaMorphoReallocateTo(
              config.publicAllocator,
              vaultAddress,
              0n, // No fee for now
              vaultWithdrawals,
              supplyMarketParams
            );
          });

          result.rawTransaction = {
            to: config.bundler,
            data: BaseBundlerV2__factory.createInterface().encodeFunctionData(
              "multicall",
              [multicallActions]
            ),
            value: "0",
          };
        }

        if (!isLiquidityFullyMatched) {
          result.reason = {
            type: "error",
            message:
              "Unable to fully match requested liquidity with available reallocations",
          };
        } else {
          result.reason = {
            type: "success",
            message: "Successfully generated reallocation transaction",
          };
        }
      } else {
        result.reason = {
          type: "error",
          message: "No onchain reallocatable liquidity available at the moment",
        };
      }
    } else {
      result.reason = {
        type: "success",
        message:
          "Sufficient liquidity already available in the market, no reallocation needed",
      };
    }

    return result;
  } catch (error) {
    console.error("Error in compareAndReallocate:", error);
    throw error;
  }
}

// Let's create a proper main function to test this
const main = async () => {
  const chainId = 8453 as ChainId;
  const marketId =
    "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as MarketId;

  // Example amounts: 20 USDC and 20M USDC
  const examples = [
    { amount: 20, label: "20 USDC" },
    { amount: 20_000_000, label: "20M USDC" },
  ];

  for (const example of examples) {
    console.log(`\n${"-".repeat(50)}`);
    console.log(`
Starting reallocation process for ${example.label}:
- Chain ID: ${chainId}
- Market ID: ${marketId}
- Requested Liquidity: ${example.amount} USDC
`);

    try {
      const result = await compareAndReallocate(
        marketId,
        chainId,
        BigInt(example.amount)
      );
      console.log(`Result for ${example.label}:`, result);
    } catch (error) {
      console.error(`Error during reallocation for ${example.label}:`, error);
    }
  }
};

// Execute the main function
main().catch(console.error);
