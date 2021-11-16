const _ = require("lodash");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const { yellow, green, red } = require("chalk");
const fetch = require("node-fetch");

require("dotenv").config();

const WAX_ENDPOINTS = [
    "https://api.wax.greeneosio.com",
    "https://api.waxsweden.org",
    "https://wax.cryptolions.io",
    "https://wax.eu.eosamsterdam.net",
    "https://api-wax.eosarabia.net",
    "https://wax.greymass.com",
    "https://wax.pink.gg",
];

async function transact(config) {
    try {
        const endpoint = _.sample(WAX_ENDPOINTS);
        const rpc = new JsonRpc(endpoint, { fetch });

        const accountAPI = new Api({
            rpc,
            signatureProvider: new JsSignatureProvider(config.privKeys),
            textEncoder: new TextEncoder(),
            textDecoder: new TextDecoder(),
        });

        const info = await rpc.get_info();
        const refBlock = await rpc.get_block(info.head_block_num - 1);
        const subId = refBlock.id.substr(16, 8);
        const prefix = parseInt(subId.substr(6, 2) + subId.substr(4, 2) + subId.substr(2, 2) + subId.substr(0, 2), 16);

        const transaction = {
            expiration: timePointSecToDate(dateToTimePointSec(refBlock.timestamp) + 3600),
            ref_block_num: 65535 & refBlock.block_num,
            ref_block_prefix: prefix,
            actions: await accountAPI.serializeActions(config.actions),
        };

        const abis = await accountAPI.getTransactionAbis(transaction);
        const serializedTransaction = accountAPI.serializeTransaction(transaction);

        const accountSignature = await accountAPI.signatureProvider.sign({
            chainId: info.chain_id,
            abis,
            requiredKeys: config.privKeys.map(pk => PrivateKey.fromString(pk).getPublicKey().toString()),
            serializedTransaction,
        });

        const pushArgs = { ...accountSignature };
        const result = await accountAPI.pushSignedTransaction(pushArgs);

        return { success: true, result };
    } catch (error) {
        console.log(red(error.message));
        return { success: false, error };
    }
}

async function fetchCrops(account, index = 0) {
    if (index >= WAX_ENDPOINTS.length) {
        return [];
    }

    try {
        const endpoint = WAX_ENDPOINTS[index];
        const rpc = new JsonRpc(endpoint, { fetch });

        const data = await rpc.get_table_rows({
            json: true,
            code: "farmersworld",
            scope: "farmersworld",
            table: "crops",
            lower_bound: account,
            upper_bound: account,
            index_position: 2,
            key_type: "i64",
            limit: 100,
        });
        return data.rows;
    } catch (error) {
        return await fetchCrops(account, index + 1);
    }
}

async function fetchTools(account, index = 0) {
    if (index >= WAX_ENDPOINTS.length) {
        return [];
    }

    try {
        const endpoint = WAX_ENDPOINTS[index];
        const rpc = new JsonRpc(endpoint, { fetch });

        const data = await rpc.get_table_rows({
            json: true,
            code: "farmersworld",
            scope: "farmersworld",
            table: "tools",
            lower_bound: account,
            upper_bound: account,
            index_position: 2,
            key_type: "i64",
            limit: 100,
        });
        return data.rows;
    } catch (error) {
        return await fetchCrops(account, index + 1);
    }
}

function makeCropAction(account, cropId) {
    return {
        account: "farmersworld",
        name: "cropclaim",
        authorization: [{ actor: account, permission: "active" }],
        data: { crop_id: cropId, owner: account },
    }
}

function makeToolAction(account, toolId) {
    return {
        account: "farmersworld",
        name: "claim",
        authorization: [{ actor: account, permission: "active" }],
        data: { asset_id: toolId, owner: account },
    }
}

async function claimCrops(crops, account, privateKey) {
    console.log("Claiming Crops");
    crops.forEach(({ asset_id, name }) => console.log(`\tClaiming ${yellow(asset_id)} ${green(name)}`));

    const actions = crops.map(({ asset_id }) => makeCropAction(account, asset_id));
    await transact({ account, privKeys: [privateKey], actions });
}

async function claimTools(crops, account, privateKey) {
    console.log("Claiming Tools");
    crops.forEach(({ asset_id, name }) => console.log(`\tClaiming ${yellow(asset_id)} ${green(name)}`));

    const actions = crops.map(({ asset_id }) => makeToolAction(account, asset_id));
    await transact({ account, privKeys: [privateKey], actions });
}

async function runCrops() {
    const { ACCOUNT_NAME, PRIVATE_KEY } = process.env;
    console.log(`Fetching crops for account ${green(ACCOUNT_NAME)}`);
    const crops = await fetchCrops(ACCOUNT_NAME);

    const claimables = crops
        .filter(({ next_availability }) => {
            const next = new Date(next_availability * 1e3);
            return next.getTime() < Date.now();
        });

    console.log(`Found ${yellow(crops.length)} crops / ${yellow(claimables.length)} crops ready to claim`);

    if (claimables.length > 0) {
        await claimCrops(claimables, ACCOUNT_NAME, PRIVATE_KEY);
    }
}

async function runTools() {
    const { ACCOUNT_NAME, PRIVATE_KEY } = process.env;
    console.log(`Fetching tools for account ${green(ACCOUNT_NAME)}`);
    const tools = await fetchTools(ACCOUNT_NAME);

    const claimables = tools
        .filter(({ next_availability }) => {
            const next = new Date(next_availability * 1e3);
            return next.getTime() < Date.now();
        });

    console.log(`Found ${yellow(tools.length)} tools / ${yellow(claimables.length)} tools ready to claim`);

    if (claimables.length > 0) {
        await claimTools(claimables, ACCOUNT_NAME, PRIVATE_KEY);
    }
}

(() => {
    const { ACCOUNT_NAME, PRIVATE_KEY, CHECK_INTERVAL } = process.env;
    const interval = (parseInt(CHECK_INTERVAL) || 5);
    console.log(`FW Bot initialization`);
    if (!ACCOUNT_NAME) {
        console.log(red("Input a valid ACCOUNT_NAME in .env"));
        process.exit(0);
    }
    if (!PRIVATE_KEY) {
        console.log(red("Input a valid PRIVATE_KEY in .env"));
        process.exit(0);
    }

    try {
        // checking if key is valid
        PrivateKey.fromString(PRIVATE_KEY).toLegacyString();
    } catch (error) {
        console.log(red("Input a valid PRIVATE_KEY in .env"));
        process.exit(0);
    }

    console.log(`Running every ${interval} minutes`);
    console.log();

    runTools();
    runCrops();

    setInterval(() => {
        runTools();
        runCrops();
    }, interval * 60e3);
})();