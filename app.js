const CONTRACT_ADDRESS = '0xF8797dB8a9EeD416Ca14e8dFaEde2BF4E1aabFC3';
const GAS_CONTRACT_ADDRESS = '0x4300000000000000000000000000000000000002';
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
let web3;
let contract;
let gasContract;
let ethPrice;
let updateInterval;
let ethPriceInterval;
const INIT_MAX_SUPPLY = 21000000;
const INITIAL_REWARD = 250;
const HALVING_INTERVAL = 42000;

// ABI Loading
async function loadABIs() {
    try {
        const [contractResponse, gasResponse] = await Promise.all([
            fetch('/abi/v3.json'),
            fetch('/abi/gas.json')
        ]);
        const contractABI = await contractResponse.json();
        const gasABI = await gasResponse.json();
        return { contractABI, gasABI };
    } catch (error) {
        console.error('Error loading ABIs:', error);
        throw error;
    }
}

// Price Functions
async function getEthPrice() {
    try {
        // Try CoinGecko first
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        const data = await response.json();
        if (data?.ethereum?.usd) {
            return data.ethereum.usd;
        }
        throw new Error('Invalid CoinGecko response');
    } catch (error) {
        console.warn('CoinGecko API failed, falling back to CryptoCompare:', error);
        try {
            // Fallback to CryptoCompare
            const response = await fetch('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD');
            const data = await response.json();
            if (data?.USD) {
                return data.USD;
            }
            throw new Error('Invalid CryptoCompare response');
        } catch (fallbackError) {
            console.error('Both price APIs failed:', fallbackError);
            return null;
        }
    }
}

// Multicall Helper
async function multicall(calls) {
    const calldata = web3.eth.abi.encodeFunctionCall({
        name: 'aggregate',
        type: 'function',
        inputs: [{
            components: [
                { name: 'target', type: 'address' },
                { name: 'callData', type: 'bytes' }
            ],
            name: 'calls',
            type: 'tuple[]'
        }],
        outputs: [
            { name: 'blockNumber', type: 'uint256' },
            { name: 'returnData', type: 'bytes[]' }
        ]
    }, [calls]);

    const response = await web3.eth.call({
        to: MULTICALL_ADDRESS,
        data: calldata
    });

    return web3.eth.abi.decodeParameters(['uint256', 'bytes[]'], response)[1];
}

// Contract Call Builders
function buildContractCalls() {
    return [
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.blockNumber().encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.totalSupply().encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.miningReward().encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.lastBlockTime().encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.halvingInterval().encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.lastHalvingBlock().encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.tokenValue().encodeABI()
        },
        {
            target: GAS_CONTRACT_ADDRESS,
            callData: gasContract.methods.readGasParams(CONTRACT_ADDRESS).encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.minersPerBlockCount(currentBlockCache + 1).encodeABI()
        },
        {
            target: CONTRACT_ADDRESS,
            callData: contract.methods.maxSupply().encodeABI()
        }
    ];
}

// Result Decoders
function decodeResults(results) {
    return {
        blockNumber: web3.eth.abi.decodeParameter('uint256', results[0]),
        totalSupply: web3.eth.abi.decodeParameter('uint256', results[1]),
        minerReward: web3.eth.abi.decodeParameter('uint256', results[2]),
        lastBlockTime: web3.eth.abi.decodeParameter('uint256', results[3]),
        halvingInterval: web3.eth.abi.decodeParameter('uint256', results[4]),
        lastHalvingBlock: web3.eth.abi.decodeParameter('uint256', results[5]),
        tokenValue: web3.eth.abi.decodeParameter('uint256', results[6]),
        gasParams: web3.eth.abi.decodeParameters(['uint256', 'uint256'], results[7]),
        minersCount: web3.eth.abi.decodeParameter('uint256', results[8]),
        maxSupply: web3.eth.abi.decodeParameter('uint256', results[9])
    };
}

// TVL Calculations
async function calculateTVL(gasParams) {
    const balance = await web3.eth.getBalance(CONTRACT_ADDRESS);
    const tvl = web3.utils.toBN(balance).add(web3.utils.toBN(gasParams[1]));
    return web3.utils.fromWei(tvl, 'ether');
}

// Value Calculations
function calculateValues(tokenValue, totalSupply, tvlEth) {
    // Convert totalSupply to ETH units
    const totalSupplyEth = web3.utils.fromWei(totalSupply, 'ether');
    
    // Calculate intrinsic value
    const intrinsicValueEth = parseFloat(web3.utils.fromWei(tokenValue, 'ether')).toFixed(10);
    const intrinsicValueUsd = (parseFloat(intrinsicValueEth) * ethPrice).toFixed(6);
    
    // Calculate theoretical value based on TVL
    const theoreticalValueEth = (parseFloat(tvlEth) / parseFloat(totalSupplyEth)).toFixed(10);
    const theoreticalValueUsd = (parseFloat(theoreticalValueEth) * ethPrice).toFixed(6);
    
    return { 
        intrinsicValueEth, 
        intrinsicValueUsd,
        theoreticalValueEth,
        theoreticalValueUsd
    };
}

// UI Updates
function updateUI(values, tvlEth) {
    const {
        blockNumber, minerReward, minersCount, lastBlockTime,
        intrinsicValueEth, intrinsicValueUsd,
        theoreticalValueEth, theoreticalValueUsd,
        maxSupply, totalSupply
    } = values;

    document.getElementById('lastBlock').textContent = blockNumber;
    document.getElementById('totalSupply').textContent = formatNumber(Math.round(totalSupply/1e18));
    document.getElementById('minerReward').textContent = minerReward/1e18;
    document.getElementById('minersCount').textContent = currentBlockCache == 0 ? '...' : minersCount;
    
    document.getElementById('intrinsicValue').textContent = intrinsicValueUsd;
    document.getElementById('intrinsicValueEth').textContent = intrinsicValueEth;
    document.getElementById('theoreticalValue').textContent = theoreticalValueUsd;
    document.getElementById('theoreticalValueEth').textContent = theoreticalValueEth;
    document.getElementById('tvl').textContent = parseFloat(tvlEth).toFixed(2);
    document.getElementById('tvlUsd').textContent = formatNumber(Math.round(parseFloat(tvlEth) * ethPrice));
    document.getElementById('maxSupply').textContent = formatNumber(maxSupply/1e18);

    // Update mined tokens metric
    const burned = calculateBurnedTokens(maxSupply/1e18);
    document.getElementById('burnedAmount').textContent = formatNumber(Math.round(burned.amount));
    document.getElementById('burnedPercentage').textContent = burned.percentage;

    const mined = calculateMinedTokens(burned.amount, totalSupply/1e18);
    document.getElementById('minedPercentage').textContent = mined.percentage;
    document.getElementById('minedAmount').textContent = formatNumber(Math.round(mined.amount));

    const secondsAgo = Math.floor((Date.now() / 1000) - lastBlockTime);
    document.getElementById('lastBlockTime').textContent = `${secondsAgo}s`;


    // Update pending block
    if (currentBlockCache !== 0) {
        // document.getElementById('pendingBlockNumber').textContent = currentBlockCache + 1;
        document.getElementById('pendingBlockMinerCount').textContent = minersCount;
        document.getElementById('pendingBlockReward').textContent = minerReward/1e18;
        document.getElementById('pendingBlockWinner').textContent = `${secondsAgo}s`;
    }
}

// Time Updates
function updateLastBlockTime(lastBlockTime) {
}

function formatTimeUntil(hours) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    const minutes = Math.floor((remainingHours % 1) * 60);

    let result = '';
    if (days > 0) result += `${days}d `;
    if (remainingHours > 0) result += `${Math.floor(remainingHours)}h `;
    if (minutes > 0) result += `${minutes}m`;
    
    return result.trim() || '0m';
}

function updateNextHalving(currentBlock, lastHalvingBlock, halvingInterval) {
    const blocksUntilHalving = (parseInt(lastHalvingBlock) + parseInt(halvingInterval)) - currentBlock;
    const hoursUntilHalving = blocksUntilHalving * 60 / 3600; // 60 seconds per block
    document.getElementById('nextHalving').textContent = formatTimeUntil(hoursUntilHalving);
}

async function getWinner(blockNumber) {
    if (blockNumber > currentBlockCache) return null;
    return '0x0000000000000000000000000000000000000000';
}

async function getMiner(blockNumber) {
    if (blockNumber > currentBlockCache) return null;
    return '0x0000000000000000000000000000000000000000';
}

function calculateReward(blockNumber) {
    // Initial reward is 250 HYPERS
    let reward = 250;
    
    const halvings = Math.floor(blockNumber / HALVING_INTERVAL);
    
    // Reduce reward by half for each halving that has occurred
    for (let i = 0; i < halvings; i++) {
        reward = reward / 2;
    }
    return reward;
}

let currentBlockCache = 0;
let loadedBlocks = new Set();

async function loadBlock(blockNumber) {
    if (loadedBlocks.has(blockNumber)) return;
    
    try {
        // Get block data
        const minersCount = await contract.methods.minersPerBlockCount(blockNumber).call();
        const winner = await getWinner(blockNumber);
        const reward = calculateReward(blockNumber);
        const miner = await getMiner(blockNumber);

        const blockElement = createBlockElement({
            blockNumber,
            minersCount,
            winner: winner,
            reward: reward,
            miner: miner
        });

        // Find the correct position to insert the block
        const blocksScroll = document.getElementById('blocksScroll');
        const existingBlocks = blocksScroll.children;
        let inserted = false;

        // Insert in descending order (newest first)
        for (let i = 1; i < existingBlocks.length; i++) {
            const existingBlockNumber = parseInt(existingBlocks[i].querySelector('.block-number').textContent.slice(1));
            if (blockNumber > existingBlockNumber) {
                blocksScroll.insertBefore(blockElement, existingBlocks[i]);
                inserted = true;
                break;
            }
        }

        // If not inserted (oldest block), append at the end
        if (!inserted) {
            blocksScroll.appendChild(blockElement);
        }

        loadedBlocks.add(blockNumber);
    } catch (error) {
        console.error(`Error loading block ${blockNumber}:`, error);
    }
}

function formatAddress(address) {
    switch (address) {
        case '0xb82619C0336985e3EDe16B97b950E674018925Bb':
            return 'KONKPool';
        case '0x2099A5d5DA9db8a91a21b7a1Cf7f969a5D078C15':
        case '0x6B8c262CA939adbe3793D3eca519a9D64f74D184':
            return 'Machi';
        default:
            return address.substring(38);
    }
}

function createBlockElement(data) {

    const block = document.createElement('div');
    block.className = 'block';
    block.innerHTML = `
        <div class="block-number">#${data.blockNumber}</div>
        <div class="block-miner-count">
            ${data.minersCount}
            <span class="mdi mdi-pickaxe"></span>
        </div>
        <a href="https://blastscan.io/address/${data.winner}" target="_blank">
            <div class="block-winner">${formatAddress(data.winner)}</div>
        </a>
        <div class="block-reward">${data.reward} $HYPERS</div>
        <a href="https://blastscan.io/address/${data.miner}" target="_blank">
            <div class="block-miner">${formatAddress(data.miner)}</div>
        </a>
    `;
    
    block.onclick = () => showBlockMiners(data.blockNumber, data.minersCount);
    return block;
}

function createPendingBlockElement() {
    const block = document.createElement('div');
    block.className = 'block';
    block.id = 'pendingBlock';
    block.innerHTML = `
        <div class="block-number" id="pendingBlockNumber">Pending block</div>
        <div class="block-miner-count">
            <span id="pendingBlockMinerCount">...</span>
            <span class="mdi mdi-pickaxe"></span>
        </div>
        <div class="block-winner" id="pendingBlockWinner">...</div>
        <div class="block-reward">
            <span id="pendingBlockReward">...</span>
            $HYPERS
        </div>
    `;
    
    block.onclick = () => showBlockMiners(document.getElementById('lastBlock').textContent, document.getElementById('pendingBlockMinerCount').textContent);
    return block;
}

async function getBlockMiners(blockNumber, totalMiners) {
    const BATCH_SIZE = 100; // Number of miners to fetch per multicall
    const miners = {};
    
    try {
        // Calculate number of batches needed
        const batchCount = Math.ceil(totalMiners / BATCH_SIZE);
        
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
            const startIndex = batchIndex * BATCH_SIZE;
            const endIndex = Math.min(startIndex + BATCH_SIZE, totalMiners);
            
            // Build calls for this batch
            const calls = [];
            for (let minerIndex = startIndex; minerIndex < endIndex; minerIndex++) {
                calls.push({
                    target: CONTRACT_ADDRESS,
                    callData: contract.methods.minersPerBlock(blockNumber, minerIndex).encodeABI()
                });
            }
            
            // Execute multicall for this batch
            const results = await multicall(calls);
            
            // Decode results and add to miners array
            for (let i = 0; i < results.length; i++) {
                const minerAddress = web3.eth.abi.decodeParameter('address', results[i]);
                miners[minerAddress] = (miners[minerAddress] || 0) + 1;
            }
            
            console.log(`Loaded miners ${startIndex} to ${endIndex} for block ${blockNumber}`);
        }
        console.log(miners);
        return miners;
        
    } catch (error) {
        console.error(`Error fetching miners for block ${blockNumber}:`, error);
        return [];
    }
}

async function showBlockMiners(blockNumber, minersCount) {
    const blockDetails = document.getElementById('blockDetails');
    document.querySelectorAll('.block').forEach(b => b.classList.remove('active'));
    if (blockNumber === null) return;

    try {
        const miners = await getBlockMiners(blockNumber, parseInt(minersCount));

        // Convert object to array of entries and sort by count
        const minersArray = Object.entries(miners)
            .sort((a, b) => b[1] - a[1]) // Sort by count descending
            .map(([address, count]) => `
                <div class="miner-item">
                    <span class="miner-count">${count}</span>
                    <span class="mdi mdi-pickaxe"></span>
                    <br>
                    <a href="https://blastscan.io/address/${address}" target="_blank">
                        ${formatAddress(address)}
                    </a>
                </div>
            `).join('');

        blockDetails.innerHTML = `
            <h3>Block #${blockNumber} Miners (${minersCount})</h3>
            <div class="miners-list">
                ${minersArray}
            </div>
        `;
        
        blockDetails.classList.add('active');
    } catch (error) {
        console.error('Error showing block miners:', error);
    }
}

// Main Update Function
async function updateAllMetrics() {
    try {
        const calls = buildContractCalls();
        const results = await multicall(calls);
        const decoded = decodeResults(results);
        
        const tvlEth = await calculateTVL(decoded.gasParams);
        
        const values = calculateValues(decoded.tokenValue, decoded.totalSupply, tvlEth);
        
        updateUI({ ...decoded, ...values }, tvlEth);
        updateLastBlockTime(decoded.lastBlockTime);
        updateNextHalving(decoded.blockNumber, decoded.lastHalvingBlock, decoded.halvingInterval);

        currentBlockCache = parseInt(decoded.blockNumber);
        
        // Load latest blocks
        const currentBlock = parseInt(decoded.blockNumber);
        for (let i = 0; i < 10; i++) {
            await loadBlock(currentBlock - i);
        }

        console.log('Contract State:', { 
            ...decoded, 
            tvlEth, 
            ethPrice,
            theoreticalValueEth: values.theoreticalValueEth,
            theoreticalValueUsd: values.theoreticalValueUsd
        });
    } catch (error) {
        console.error('Error updating metrics:', error);
        const metrics = ['lastBlock', 'totalSupply', 'minerReward', 'minersCount', 
                        'lastBlockTime', 'nextHalving', 'intrinsicValue', 'theoreticalValue',
                        'intrinsicValueEth', 'theoreticalValueEth', 'tvl'];
        metrics.forEach(id => document.getElementById(id).textContent = '...');
    }
}

// Initialization
async function init() {
    try {
        if (updateInterval) clearInterval(updateInterval);
        if (ethPriceInterval) clearInterval(ethPriceInterval);

        const { contractABI, gasABI } = await loadABIs();
        ethPrice = await getEthPrice();
        if (!ethPrice) {
            console.error('Failed to get ETH price');
            return;
        }
        
        web3 = new Web3('https://rpc.blast.io');
        contract = new web3.eth.Contract(contractABI, CONTRACT_ADDRESS);
        gasContract = new web3.eth.Contract(gasABI, GAS_CONTRACT_ADDRESS);
        const pendingBlock = createPendingBlockElement();
        document.getElementById('blocksScroll').appendChild(pendingBlock);
        await updateAllMetrics();
        initializeInfiniteScroll();
        updateInterval = setInterval(updateAllMetrics, 1000);
        ethPriceInterval = setInterval(async () => {
            ethPrice = await getEthPrice();
        }, 60000);
    } catch (error) {
        console.error('Initialization error:', error);
    }
}

function formatNumber(num) {
    return new Intl.NumberFormat('en-US').format(parseFloat(num));
}

function calculateMinedTokens(burnedAmount, totalSupply) {
    let totalMined = burnedAmount + totalSupply;
    
    const percentage = (totalMined / INIT_MAX_SUPPLY) * 100;

    return {
        amount: totalMined,
        percentage: percentage.toFixed(2)
    };
}

// Fix the burned tokens calculation
function calculateBurnedTokens(maxSupply) {
    const burnedAmount = INIT_MAX_SUPPLY - maxSupply;
    const burnedPercentage = (burnedAmount / INIT_MAX_SUPPLY) * 100;
    
    return {
        amount: burnedAmount,
        percentage: burnedPercentage.toFixed(2)
    };
}

// Remove the load more button from HTML

// Remove the load more button event listener and add scroll detection
function initializeInfiniteScroll() {
    const blocksContainer = document.querySelector('.blocks-container');
    let isLoading = false;

    blocksContainer.addEventListener('scroll', async () => {
        // Check if we're near the right edge (where older blocks are)
        const scrollLeft = blocksContainer.scrollLeft;
        const scrollWidth = blocksContainer.scrollWidth;
        const clientWidth = blocksContainer.clientWidth;
        
        // Load more when we're within 20% of the right edge
        if (!isLoading && (scrollWidth - (scrollLeft + clientWidth)) / clientWidth < 0.2) {
            isLoading = true;
            
            const oldestBlock = Math.min(...Array.from(loadedBlocks));
            // Load older blocks
            for (let i = 1; i <= 5; i++) {
                await loadBlock(oldestBlock - i);
            }
            
            isLoading = false;
        }
    });
}

// Initialize
init(); 