# Morpho API Public Allocator

## Overview

Fetch data from the Morpho API and reallocate liquidity using the PublicAllocator contract. Create JSON batches for transactions.
Note: Currently, the API might have a 1 min delay. This repo is for education only.

## Quick Start

1. **Clone the repository**:

   ```sh
   git clone <repository_url>
   cd <repository_directory>
   ```

2. **Install dependencies**:

   ```sh
   npm install
   ```

3. **Change variables**:
   In the apiSafePublicAllocator.ts file, change the following variables:

   ```typescript
   const chainId = 1;
   const marketId =
     "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
   const SAFE_ADDRESS = "0xAA";
   ```

4. **Run the script**:

```sh
ts-node apiSafePublicAllocator.ts
```
