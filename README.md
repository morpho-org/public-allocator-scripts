# Morpho API Public Allocator

This repository contains scripts to fetch data from the Morpho API and prepare transactions to reallocate liquidity using the public allocator.

## Note

- The API might have a 1-minute delay. This repository is for educational purposes only.
- Data returned from the API follows an algorithm that ensures reallocatable liquidity and considers the utilization cap to avoid pushing the market's utilization beyond 92%.
- For more information, contact us on Telegram or [Discord](https://discord.morpho.org).

## Quick Start

1. **Clone the repository**:

   ```sh
   git clone <repository_url>
   cd <repository_directory>
   ```

2. **Install dependencies**:

   ```sh
   npm install
   #or
   yarn install
   ```

## Scripts

### API - Public Allocator - Safe TxBuilder

Fetch data from the Morpho API and implement liquidity reallocation using the PublicAllocator contract. Creates `safebatch.json` for batch transactions to upload to the safe transaction builder.

#### 1. Change variables:

Update the following variables in `apiSafePublicAllocator.ts`:

```typescript
const chainId = 1;
const marketId =
  "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
const SAFE_ADDRESS = "0xAA";
```

#### 2. Run the script:

```sh
ts-node scripts/apiSafePublicAllocator.ts
```

### API - Bundler Multicall

Fetch data from the Morpho API and implement liquidity reallocation using the Bundler contract. Creates `rawTransaction.json` that one can execute from anywhere.

#### 1. Change variables:

Update the following variables in `apiBundler.ts`:

```typescript
const chainId = 1;
const marketId =
  "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
```

#### 2. Run the script:

```sh
ts-node scripts/apiBundler.ts
```

### License:

This project is licensed under the MIT License.
