# Morpho Public Allocator - Bundler Implementation

This repository provides tools to fetch data from Morpho Blue markets and prepare reallocation transactions using the public allocator via the Bundler contract. The implementation supports both Ethers.js and Viem for maximum flexibility.

![Reallocation Flow](./scripts/image.png)

## ⚠️ SDK Versions Notice

Current SDK versions are in pre-release. Use the following commands to install the latest next versions:

### For Ethers.js Implementation

```bash
yarn add @morpho-org/blue-sdk@next
yarn add @morpho-org/blue-sdk-ethers@next
yarn add @morpho-org/liquidity-sdk-ethers@next
yarn add @morpho-org/morpho-blue-bundlers@latest
yarn add @morpho-org/morpho-ts@next
yarn add @morpho-org/simulation-sdk@next
yarn add ethers@^6.13.1
yarn add dotenv
```

### For Viem Implementation

```bash
yarn add @morpho-org/blue-sdk@next
yarn add @morpho-org/blue-sdk-viem@next
yarn add @morpho-org/liquidity-sdk-viem@next
yarn add @morpho-org/morpho-blue-bundlers@latest
yarn add @morpho-org/morpho-ts@next
yarn add @morpho-org/simulation-sdk@next
yarn add viem@^2.21.54
yarn add dotenv
```

> **Note:** npm has issues parsing package names containing '@' symbols. We recommend using **yarn** or **pnpm** instead.  
> If one really needs to use **npm**, use exact versions in package.json:
> ```json
> {
>    "@morpho-org/blue-api-sdk": "2.0.0-next.14",
>    "@morpho-org/blue-sdk": "2.0.0-next.32",
>    "@morpho-org/blue-sdk-ethers": "2.0.0-next.30",
>    "@morpho-org/blue-sdk-viem": "2.0.0-next.30",
>    "@morpho-org/liquidity-sdk-ethers": "2.0.0-next.6",
>    "@morpho-org/liquidity-sdk-viem": "2.0.0-next.6",
>    "@morpho-org/morpho-blue-bundlers": "1.1.2",
>    "@morpho-org/morpho-ts": "2.0.0-next.16",
>    "@morpho-org/simulation-sdk": "2.0.0-next.30",
> }
> ```

## Environment Setup

Create a `.env` file in the root directory with the following variables:

```env
RPC_URL_MAINNET=your_mainnet_rpc_url_here
RPC_URL_BASE=your_base_rpc_url_here
```

## Performance Considerations

The script implements a two-step data fetching process for optimal performance:

1. **Initial Quick Overview**: Uses the Morpho API to fetch basic liquidity data

   - More efficient for initial checks
   - May have a ~1 minute delay
   - Suitable for UI displays and quick checks

2. **Detailed RPC Data**: Only fetched when reallocation is needed
   - More resource-intensive
   - Provides real-time data
   - Required for accurate transaction preparation

## Stack Choice

Both Ethers.js and Viem implementations provide identical functionality. Choose based on your existing stack:

- Use Ethers.js version if you're already using Ethers.js in your project
- Use Viem version if you're using Viem or starting a new project

## Usage

1. Update the market parameters in your script:

```typescript
const marketId = "0x..." as MarketId; // Your target market
const chainId = 1; // or 8453 for Base
const REQUESTED_LIQUIDITY = BigInt("1000000000000000000"); // Amount in wei
```

2. Run the script:

```bash
ts-node scripts/ethers/sdkBundler.ts
```

or

```bash
ts-node scripts/viem/sdkBundler.ts
```

The script will:

1. Fetch initial market metrics from the API
2. Check current market liquidity
3. Determine if reallocation is needed
4. Optional: Run market state simulations
5. Process withdrawals if needed
6. Generate and save transaction data to `rawTransaction.json`

## Reallocation Flow

[Mermaid Link for preview](https://mermaid.live/view#pako:eNqVVW1v2jAQ_iunVK1aKZW20rUjHzZtQLVJa8sAadpCPxjHNBaOndkOFNH-910SGxJabR0IEufuee65FzubgKqEBVEwF2pFU6ItTD5PJeBnbHF1HFeXuxM4Pf0An4ZfY_xFcMUsTeGa6AWzcM2s5tTA94LTBdwumV5ytrqrWdC9gjqnuM9NLsgaeoXWTFo4ghEjQihKLJkJBt_474In3K5hrrSLYBxXm_FW9lLCZTwa9rwgT-qEoXTLWliHqfC9lNHFZiBVcZ_uwn58avofHsKAaLEGU1DKjIGc2LQ2VfCS6PEnM48wrh22-Q0eKv8tr5Ph3CoBA5kcx_h3d7IXEjOCIQaqSqB9ebiS-5Fv1GPp3CzBqOEOfSyqC1xylkFb1d58Iab95Fn6NwrEtiW77NtN81rGqdJ2jpYY71aNXm4Nvgx-7QuxF3WcC26BS6vA8KwQdTpLAwnXjNq_CqnbwbO6v-Md_Bon_Vl-DfuO1KNbfLFzZa3x8rOJxioXvLoR2I5CI8SImULYBsb7lNChVuVs7Ans7zKGFbepKmyjJi_oLRvhqGJ3hR8ITDRZEdHeS8jfU1mGyphMuLyvJm6mMFQZz0nxJKXGyUPcw4nEIhzBmCwZTDSRhtBSi2OePNSFKLKM6HV8xSURfrXdBdVq1_z6MRXEmD6bQ8LmBOsEcy5EdDDvlt_QWK0WLDrodDohVULpaCYIXexBucwLDzwn3Tfs7AXgKuWW7QFzl2UNPWOUXr59JZTk3ME65933yeyVMJ1TB-vO3nVnF6-E-U79f4qNrVSj2cUlO_sHusFRvxJC7Fhd5qYJT-XQvwiwHk2TO3RDPIJCN0shDgmm3-LmWdjYEDutQRhkTGeEJ_ia2pSQaWBTlrFpEOFtgptxGkzlE_qRwqrxWtIgsrpgYaDLsz2I8KAxuCryBAe3z8m9Jpl3yYn8pVTmnJ7-AIl_Vec)

## Note

- API data has a potential 1-minute delay
- Reallocatable liquidity calculations consider utilization caps (92% max)
- For support, reach out on [Discord](https://discord.morpho.org)

## License

This project is licensed under the MIT License.
