flowchart LR
Start([Start]) --> API[API: Fetch Market Metrics Quick Overview]
API --> Metrics[Display Current & Reallocatable Liquidity for Market]

    API --> OnChain[RPC: Fetch Current Market State]

    OnChain --> Check{Enough Liquidity?}

    %% Early success path
    Check -->|Yes| Success[Display Excess Liquidity]
    Success --> End([End])

    %% RPC Path for reallocation
    Check -->|No| RPC[RPC: Fetch Reallocation Data]
    RPC --> Reallocatable{Has Reallocatable?}

    %% No liquidity path
    Reallocatable -->|No| Shortfall[Show Liquidity Shortfall]
    Shortfall --> End

    %% Split into simulation vs direct path
    Reallocatable -->|Yes| SimCheck{Simulation Mode?}

    %% Simulation path
    SimCheck -->|Yes| Sim[Simulate Market States]
    Sim --> SimDisplay[Display Simulation Results]
    SimDisplay --> Process

    %% Direct path without simulation
    SimCheck -->|No| Process[Process Withdrawals]

    %% Common ending for both paths
    Process --> Tx[Create & Save Transaction]
    Tx --> Summary[Final Summary]
    Summary --> End

    classDef default fill:#f9f9f9,stroke:#333,color:black
    classDef input fill:#4a90e2,stroke:#333,color:white
    classDef process fill:#2ecc71,stroke:#333,color:white
    classDef api fill:#3498db,stroke:#333,color:white
    classDef rpc fill:#9b59b6,stroke:#333,color:white
    classDef ending fill:#4a90e2,stroke:#333,color:white
    classDef simulation fill:#e67e22,stroke:#333,color:white

    class Start,End input
    class API,Metrics api
    class OnChain,RPC,Process,Tx rpc
    class Sim,SimDisplay simulation
