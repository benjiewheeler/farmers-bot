const _ = require("lodash");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const { magenta, yellow, green, red } = require("chalk");
const fetch = require("node-fetch");
const axios = require("axios");
const { TextEncoder, TextDecoder } = require("util");

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

async function fetchTable(account, table, tableIndex, index = 0) {
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
			index_position: tableIndex,
			key_type: "i64",
			limit: 100,
		});
		return data.rows;
	} catch (error) {
		return await fetchTable(account, table, tableIndex, index + 1);
	}
}

async function fetchCrops(account) {
	return await fetchTable(account, "crops", 2);
}

async function fetchTools(account) {
	return await fetchTable(account, "tools", 2);
}

async function fetchAccount(account) {
	return await fetchTable(account, "accounts", 1);
}

async function fetchAnimls(account) {
	return await fetchTable(account, "animals", 2);
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

function makeToolClaimAction(account, toolId) {
	return {
		account: "farmersworld",
		name: "claim",
		authorization: [{ actor: account, permission: "active" }],
		data: { asset_id: toolId, owner: account },
	};
}

function makeToolRepairAction(account, toolId) {
	return {
		account: "farmersworld",
		name: "repair",
		authorization: [{ actor: account, permission: "active" }],
		data: { asset_id: toolId, asset_owner: account },
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

async function repairTools() {
	const { ACCOUNT_NAME, PRIVATE_KEY, REPAIR_THRESHOLD, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const threshold = parseFloat(REPAIR_THRESHOLD) || 50;

	console.log(`Fetching tools for account ${green(ACCOUNT_NAME)}`);
	const tools = await fetchTools(ACCOUNT_NAME);

	const repeairables = tools.filter(({ durability, current_durability }) => {
		const percentage = 100 * (current_durability / durability);
		return percentage < threshold;
	});

	console.log(`Found ${yellow(tools.length)} tools / ${yellow(repeairables.length)} tools ready to be repaired`);

	if (repeairables.length > 0) {
		console.log("Repairing Tools");

		for (let i = 0; i < repeairables.length; i++) {
			const tool = repeairables[i];

			const delay = _.random(delayMin, delayMax);

			console.log(
				`\tRepairing tool ${yellow(tool.asset_id)}`,
				`(for ${green(tool.type)})`,
				`(durability ${yellow(tool.current_durability)} / ${yellow(tool.durability)})`,
				magenta(`(${Math.round((tool.current_durability / tool.durability) * 100)}%)`),
				`(after a ${delay}s delay)`
			);
			const actions = [makeToolRepairAction(ACCOUNT_NAME, tool.asset_id)];

			await waitFor(delay);
			await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
		}
	}
}

async function feedAnimals() {
	const { ACCOUNT_NAME, PRIVATE_KEY, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

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

			console.log("Feeding Animals");

			for (let i = 0; i < feedables.length; i++) {
				const animal = feedables[i];
				const foodItemIndex = [...food].findIndex(
					item => parseInt(item.template.template_id) == ANIMAL_FOOD[animal.template_id]
				);

				if (foodItemIndex == -1) {
					console.log(`\t${yellow("No compatible food found for")} ${green(animal.name)}`);
					continue;
				}

				const [foodItem] = [...food].splice(foodItemIndex, 1);
				const delay = _.random(delayMin, delayMax);

				console.log(
					`\tFeeding ${yellow(animal.asset_id)} ${green(animal.name)} with ${foodItem.name} (${
						foodItem.asset_id
					}) (after a ${delay}s delay)`
				);
				const actions = [makeFeedingAction(ACCOUNT_NAME, animal.asset_id, foodItem.asset_id)];

				await waitFor(delay);
				await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
			}
		}
	}
}

async function claimCrops() {
	const { ACCOUNT_NAME, PRIVATE_KEY, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	console.log(`Fetching crops for account ${green(ACCOUNT_NAME)}`);
	const crops = await fetchCrops(ACCOUNT_NAME);

	const claimables = crops.filter(({ next_availability }) => {
		const next = new Date(next_availability * 1e3);
		return next.getTime() < Date.now();
	});

	console.log(`Found ${yellow(crops.length)} crops / ${yellow(claimables.length)} crops ready to claim`);

	if (claimables.length > 0) {
		console.log("Claiming Crops");

		for (let i = 0; i < claimables.length; i++) {
			const crop = claimables[i];

			const delay = _.random(delayMin, delayMax);

			console.log(`\tClaiming crop ${yellow(crop.asset_id)} ${green(crop.name)} (after a ${delay}s delay)`);
			const actions = [makeCropAction(ACCOUNT_NAME, crop.asset_id)];

			await waitFor(delay);
			await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
		}
	}
}

async function useTools() {
	const { ACCOUNT_NAME, PRIVATE_KEY, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	console.log(`Fetching tools for account ${green(ACCOUNT_NAME)}`);
	const tools = await fetchTools(ACCOUNT_NAME);

	const claimables = tools.filter(({ next_availability }) => {
		const next = new Date(next_availability * 1e3);
		return next.getTime() < Date.now();
	});

	console.log(`Found ${yellow(tools.length)} tools / ${yellow(claimables.length)} tools ready to claim`);

	if (claimables.length > 0) {
		console.log("Claiming Tools");

		for (let i = 0; i < claimables.length; i++) {
			const tool = claimables[i];

			const delay = _.random(delayMin, delayMax);

			console.log(
				`\tClaiming with tool ${yellow(tool.asset_id)} (for ${green(tool.type)}) (after a ${delay}s delay)`
			);
			const actions = [makeToolClaimAction(ACCOUNT_NAME, tool.asset_id)];

			await waitFor(delay);
			await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
		}
	}
}

async function runTasks() {
	await repairTools();
	console.log(); // just for clarity

	await useTools();
	console.log(); // just for clarity

	await claimCrops();
	console.log(); // just for clarity

	await feedAnimals();
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

	runTasks();

	setInterval(() => runTasks(), interval * 60e3);
})();
