require('dotenv').config();

// Web3 access
const Web3 = require('_Web3');
// Uniswap SDK
const {Uniswap_ChainId,Uniswap_TokenAmount,Uniswap_Fetcher} = require('@uniswap/sdk');

const Abis = require('./abis');

// Addresses we utilize
const {mainnet : Addresses} = require('./addresses');

const Flashloan = require('./build/contracts/Flashloan.json');

const _Web3 = new Web3(
    new Web3.providers.WebsocketProvider(process.env.INFURA_URL)
);

const {address:Admin} = _Web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

_Web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

const Kyber = new _Web3.eth.Contract(
    Abis.kyber.kyberNetworkProxy,
    Addresses.kyber.kyberNetworkProxy
);

const AMOUNT_ETH = 100;
const RECENT_ETH_PRICE = 1520;
const AMOUNT_ETH_WEI = _Web3.utils.toWei(AMOUNT_ETH.toString());
const AMOUNT_DAI_WEI = _Web3.utils.toWei((AMOUNT_ETH * RECENT_ETH_PRICE).toString());
const DIRECTION = {KYBER_TO_UNISWAP: 0, UNISWAP_TO_KYBER: 1};

const init = async() =>
 {
    const NetworkId_ETH = await _Web3.eth.net.getId();
    const _Flashloan = new _Web3.eth.Contract(Flashloan.abi, Flashloan.networks[NetworkId_ETH].address);
    const [Dai,Weth] = await Promise.all
    (
        [Addresses.tokens.Dai, Addresses.tokens.Weth].map(tokenAddress => (Uniswap_Fetcher.fetchTokenData(Uniswap_ChainId.MAINNET, tokenAddress)))
    );
    
    const DaiWeth = await Uniswap_Fetcher.fetchPairData(Dai,Weth);

    _Web3.eth.subscribe('newBlockHeaders')
    .on('data', async block => {
        console.log(`New block received. Block #${block.number}`);
    
        const KyberResults = await Promise.all
        ([
            Kyber.methods.getExpectedRate(Addresses.tokens.Dai,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',AMOUNT_DAI_WEI).call(),
            Kyber.methods.getExpectedRate('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',Addresses.tokens.Dai,AMOUNT_ETH_WEI).call()
        ]);
    
        const KyberRates = 
        {
            buy: parseFloat(1 / (KyberResults[0].expectedRate / (10 ** 18))),
            sell: parseFloat(KyberResults[1].expectedRate / (10 ** 18))
        };
    
        console.log('Kyber ETH/DAI');
        console.log(KyberRates);
    
        const UniswapResults = await Promise.all
        ([
            DaiWeth.getOutputAmount(new Uniswap_TokenAmount(Dai,AMOUNT_DAI_WEI)),
            DaiWeth.getOutputAmount(new Uniswap_TokenAmount(Weth,AMOUNT_ETH_WEI))
        ]);

        const UniswapRates = 
        {
            buy: parseFloat(AMOUNT_DAI_WEI / (UniswapResults[0][0].toExact() * 10 ** 18)),
            sell: parseFloat(UniswapResults[1][0].toExact() / (AMOUNT_ETH))
        }
        console.log('Uniswap ETH/DAI');
        console.log(UniswapRates);

        // initiateFlashloan for every direction
        const [TransactionKyberToUni, TransactionUniToKyber] = Object.keys(DIRECTION).map(direction => _Flashloan.methods.initiateFlashloan(Addresses.dydx.solo, Addresses.tokens.Dai, AMOUNT_DAI_WEI, DIRECTION[direction]));
        
        // Get gas price and gas cost for dir1 and dir2 
        const [GasPrice, GasCost1, GasCost2] = await Promise.all([_Web3.eth.getGasPrice(), TransactionKyberToUni.estimateGas({from: Admin}), TransactionUniToKyber.estimateGas({from: Admin})]);

        const TransactionCostKyberToUni = parseInt(GasCost1) * parseInt(GasPrice);
        const TransactionCostUniToKyber = parseInt(GasCost2) * parseInt(GasPrice);

        const CurrentEthPrice = (UniswapRates.buy + UniswapRates.sell) / 2; 

        const ProfitKyberToUni = (parseInt(AMOUNT_ETH_WEI) / 10 ** 18) * (UniswapRates.sell - KyberRates.buy) - (TransactionCostKyberToUni / 10 ** 18) * CurrentEthPrice;
        const ProfitUniToKyber = (parseInt(AMOUNT_ETH_WEI) / 10 ** 18) * (KyberRates.sell - UniswapRates.buy) - (TransactionCostUniToKyber / 10 ** 18) * CurrentEthPrice;

        if(ProfitKyberToUni > 0) 
        {
          console.log('Arb opportunity found!');
          console.log(`Buy ETH on Kyber at ${KyberRates.buy} Dai`);
          console.log(`Sell ETH on Uniswap at ${UniswapRates.sell} Dai`);
          console.log(`Expected profit: ${ProfitKyberToUni} Dai`);
          const Data = TransactionKyberToUni.encodeABI();

          const TransactionData = {
            from: Admin,
            to: _Flashloan.options.address,
            Data,
            gas: GasCost1,
            GasPrice
          };

          const receipt = await _Web3.eth.sendTransaction(TransactionData);
          console.log(`Transaction hash: ${receipt.transactionHash}`);
        } 
        else if(ProfitUniToKyber > 0) 
        {
          console.log('Arb opportunity found!');
          console.log(`Buy ETH from Uniswap at ${UniswapRates.buy} Dai`);
          console.log(`Sell ETH from Kyber at ${KyberRates.sell} Dai`);
          console.log(`Expected profit: ${ProfitUniToKyber} Dai`);
          const Data = TransactionUniToKyber.encodeABI();
          const TransactionData = {
            from: Admin,
            to: _Flashloan.options.address,
            Data,
            gas: GasCost2,
            GasPrice
          };
          const receipt = await _Web3.eth.sendTransaction(TransactionData);
          console.log(`Transaction hash: ${receipt.transactionHash}`);
        }
    })
    .on('error', error => {
        console.log(error);
    });
 }

 init();


