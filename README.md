# Morpho API Public Allocator

## Overview

Fetch data from the Morpho API and reallocate liquidity using the PublicAllocator contract. Create JSON batches for transactions.

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

3. **Set up variables**:

   ```sh
   echo "API_URL=https://blue-api.morpho.org/graphql" >> .env
   echo "SAFE_ADDRESS=0xAAA" >> .env
   ```

4. **Run the script**:
   ```sh
   ts-node apiSafePublicAllocator.ts
   ```
