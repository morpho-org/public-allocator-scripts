flowchart TB
Start([Start]) --> Initialize[Initialize Client & Loader]
Initialize --> Parallel{Parallel Fetch}

    Parallel --> API[API: Fetch Market Metrics]
    Parallel --> Market[Fetch Market Data]

    API & Market --> Calculate[Calculate Required Assets]

    Calculate --> CheckUtil{Utilization > Target?}

    %% No reallocation needed path
    CheckUtil -->|No| Success[No Reallocation Needed]
    Success --> End([End])

    %% Reallocation path
    CheckUtil -->|Yes| FetchRPC[RPC: Fetch Reallocation Data]
    FetchRPC --> HasLiquidity{Has Reallocatable Liquidity?}

    %% No liquidity path
    HasLiquidity -->|No| NoLiquidity[No Reallocatable Liquidity]
    NoLiquidity --> End

    %% Process reallocation path
    HasLiquidity -->|Yes| Process[Process Reallocations]
    Process --> Simulate[Simulate Market States]

    Simulate --> CheckMatch{Liquidity Fully Matched?}

    CheckMatch -->|No| Shortfall[Show Liquidity Shortfall]
    Shortfall --> GenTx[Generate Transaction]

    CheckMatch -->|Yes| GenTx

    GenTx --> Summary[Final Summary]
    Summary --> End

    classDef default fill:#f9f9f9,stroke:#333,color:black
    classDef input fill:#4a90e2,stroke:#333,color:white
    classDef process fill:#2ecc71,stroke:#333,color:white
    classDef api fill:#3498db,stroke:#333,color:white
    classDef rpc fill:#9b59b6,stroke:#333,color:white
    classDef check fill:#f1c40f,stroke:#333,color:black
    classDef simulation fill:#e67e22,stroke:#333,color:white

    class Start,End input
    class API,Market api
    class FetchRPC,Process rpc
    class CheckUtil,HasLiquidity,CheckMatch check
    class Simulate simulation
