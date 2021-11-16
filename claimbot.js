const _ = require("lodash");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const { yellow, green, red } = require("chalk");
const fetch = require("node-fetch");
const axios = require("axios");

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

const ATOMIC_ENDPOINTS = [
	"https://aa.wax.blacklusion.io",
	"https://wax-atomic-api.eosphere.io",
	"https://wax.api.atomicassets.io",
	"https://wax.blokcrafters.io",
];

const ANIMAL_FOOD = {
	// animal_template: food_template
	298597: 298593, // Baby Calf consumes Milk
	298603: 318606, // Cow       consumes Barley
	298607: 318606, // Dairy Cow consumes Barley
	298613: 318606, // Chick     consumes Barley
	298614: 318606, // Chicken   consumes Barley
};

async function waitFor(t) {
	return new Promise(resolve => setTimeout(() => resolve(), t * 1e3));
}

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
		const subId = info.head_block_id.substr(16, 8);
		const prefix = parseInt(subId.substr(6, 2) + subId.substr(4, 2) + subId.substr(2, 2) + subId.substr(0, 2), 16);

		const transaction = {
			expiration: timePointSecToDate(dateToTimePointSec(info.head_block_time) + 3600),
			ref_block_num: 65535 & info.head_block_num,
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

async function fetchTable(account, table, index = 0) {
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
			table: table,
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

async function fetchCrops(account) {
	return await fetchTable(account, "crops");
}

async function fetchTools(account) {
	return await fetchTable(account, "tools");
}

async function fetchAnimls(account) {
	return await fetchTable(account, "animals");
}

async function fetchFood(account, index = 0) {
	if (index >= ATOMIC_ENDPOINTS.length) {
		return [];
	}

	try {
		const endpoint = ATOMIC_ENDPOINTS[index];
		const response = await axios.get(`${endpoint}/atomicassets/v1/assets`, {
			params: { owner: account, collection_name: "farmersworld", schema_name: "foods", page: 1, limit: 10 },
			timeout: 5e3,
		});

		return response.data.data;
	} catch (error) {
		return await fetchFood(account, index + 1);
	}
}

function makeCropAction(account, cropId) {
	return {
		account: "farmersworld",
		name: "cropclaim",
		authorization: [{ actor: account, permission: "active" }],
		data: { crop_id: cropId, owner: account },
	};
}

function makeToolAction(account, toolId) {
	return {
		account: "farmersworld",
		name: "claim",
		authorization: [{ actor: account, permission: "active" }],
		data: { asset_id: toolId, owner: account },
	};
}

function makeFeedingAction(account, animalId, foodId) {
	return {
		account: "atomicassets",
		name: "transfer",
		authorization: [{ actor: account, permission: "active" }],
		data: { asset_ids: [animalId], from: account, memo: `feed_animal:${foodId}`, to: "farmersworld" },
	};
}

async function claimCrops(crops, account, privateKey) {
	console.log("Claiming Crops");

	for (let i = 0; i < crops.length; i++) {
		const crop = crops[i];

		const delay = _.random(4, 10);

		console.log(`\tClaiming crop ${yellow(crop.asset_id)} ${green(crop.name)} (with a ${delay}s delay)`);
		const actions = [makeCropAction(account, crop.asset_id)];

		await waitFor(delay);
		await transact({ account, privKeys: [privateKey], actions });
	}
}

async function claimTools(tools, account, privateKey) {
	console.log("Claiming Tools");

	for (let i = 0; i < tools.length; i++) {
		const tool = tools[i];

		const delay = _.random(4, 10);

		console.log(`\tClaiming with tool ${yellow(tool.asset_id)} ${green(tool.name)} (with a ${delay}s delay)`);
		const actions = [makeToolAction(account, tool.asset_id)];

		await waitFor(delay);
		await transact({ account, privKeys: [privateKey], actions });
	}
}

async function feedAnimals(animals, food, account, privateKey) {
	console.log("Feeding Animals");

	for (let i = 0; i < animals.length; i++) {
		const animal = animals[i];
		const foodItemIndex = [...food].findIndex(
			item => parseInt(item.template.template_id) == ANIMAL_FOOD[animal.template_id]
		);

		if (foodItemIndex == -1) {
			console.log(`\t${yellow("No compatible food found for")} ${green(animal.name)}`);
			continue;
		}

		const [foodItem] = [...food].splice(foodItemIndex, 1);
		const delay = _.random(4, 10);

		console.log(
			`\tFeeding ${yellow(animal.asset_id)} ${green(animal.name)} with ${foodItem.name} (${
				foodItem.asset_id
			}) (with a ${delay}s delay)`
		);
		const actions = [makeFeedingAction(account, animal.asset_id, foodItem.asset_id)];

		await waitFor(delay);
		await transact({ account, privKeys: [privateKey], actions });
	}
}

async function runCrops() {
	const { ACCOUNT_NAME, PRIVATE_KEY } = process.env;
	console.log(`Fetching crops for account ${green(ACCOUNT_NAME)}`);
	const crops = await fetchCrops(ACCOUNT_NAME);

	const claimables = crops.filter(({ next_availability }) => {
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

	const claimables = tools.filter(({ next_availability }) => {
		const next = new Date(next_availability * 1e3);
		return next.getTime() < Date.now();
	});

	console.log(`Found ${yellow(tools.length)} tools / ${yellow(claimables.length)} tools ready to claim`);

	if (claimables.length > 0) {
		await claimTools(claimables, ACCOUNT_NAME, PRIVATE_KEY);
	}
}

async function runFeeding() {
	const { ACCOUNT_NAME, PRIVATE_KEY } = process.env;
	console.log(`Fetching animals for account ${green(ACCOUNT_NAME)}`);
	const animals = await fetchAnimls(ACCOUNT_NAME);

	const feedables = animals.filter(({ next_availability }) => {
		const next = new Date(next_availability * 1e3);
		return next.getTime() < Date.now();
	});

	console.log(`Found ${yellow(animals.length)} animals / ${yellow(feedables.length)} animals ready to feed`);

	if (feedables.length > 0) {
		console.log(`Fetching food from account ${green(ACCOUNT_NAME)}`);
		const food = await fetchFood(ACCOUNT_NAME);
		console.log(`Found ${yellow(food.length)} food`);

		if (food.length) {
			if (feedables.length > food.length) {
				console.log(yellow("Warning: You don't have enough food to feed all your animals"));
			}

			await feedAnimals(feedables, food, ACCOUNT_NAME, PRIVATE_KEY);
		}
	}
}

async function runAll() {
	await runTools();
	console.log(); // just for clarity

	await runCrops();
	console.log(); // just for clarity

	await runFeeding();
	console.log(); // just for clarity
}

(() => {
	const { ACCOUNT_NAME, PRIVATE_KEY, CHECK_INTERVAL } = process.env;
	const interval = parseInt(CHECK_INTERVAL) || 5;
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

	runAll();

	setInterval(() => runAll(), interval * 60e3);
})();
