const axios = require("axios");
const { cyan, green, magenta, red, yellow } = require("chalk");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const _ = require("lodash");
const fetch = require("node-fetch");
const { TextDecoder, TextEncoder } = require("util");

require("dotenv").config();

const WAX_ENDPOINTS = _.shuffle([
	"https://api.wax.greeneosio.com",
	"https://api.waxsweden.org",
	"https://wax.cryptolions.io",
	"https://wax.eu.eosamsterdam.net",
	"https://api-wax.eosarabia.net",
	"https://wax.greymass.com",
	"https://wax.pink.gg",
]);

const ATOMIC_ENDPOINTS = _.shuffle([
	"https://aa.wax.blacklusion.io",
	"https://wax-atomic-api.eosphere.io",
	"https://wax.api.atomicassets.io",
	"https://wax.blokcrafters.io",
]);

const ANIMAL_FOOD = {
	// animal_template: food_template
	298597: 298593, // Baby Calf consumes Milk
	298603: 318606, // Cow       consumes Barley
	298607: 318606, // Dairy Cow consumes Barley
	298613: 318606, // Chick     consumes Barley
	298614: 318606, // Chicken   consumes Barley
};

const Configs = {
	WAXEndpoints: [...WAX_ENDPOINTS],
	atomicEndpoints: [...ATOMIC_ENDPOINTS],
	animals: [],
	tools: [],
};

async function shuffleEndpoints() {
	// shuffle endpoints to avoid spamming a single one
	Configs.WAXEndpoints = _.shuffle(WAX_ENDPOINTS);
	Configs.atomicEndpoints = _.shuffle(ATOMIC_ENDPOINTS);
}

/**
 *
 * @param {number} t in seconds
 * @returns {Promise<void>}
 */
async function waitFor(t) {
	return new Promise(resolve => setTimeout(() => resolve(), t * 1e3));
}

async function transact(config) {
	try {
		const endpoint = _.sample(Configs.WAXEndpoints);
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

		console.log(green(result.transaction_id));
	} catch (error) {
		console.log(red(error.message));
	}
}

async function fetchTable(account, table, tableIndex, index = 0) {
	if (index >= Configs.WAXEndpoints.length) {
		return [];
	}

	try {
		const endpoint = Configs.WAXEndpoints[index];
		const rpc = new JsonRpc(endpoint, { fetch });

		const data = await Promise.race([
			rpc.get_table_rows({
				json: true,
				code: "farmersworld",
				scope: "farmersworld",
				table: table,
				lower_bound: account,
				upper_bound: account,
				index_position: tableIndex,
				key_type: "i64",
				limit: 100,
			}),
			waitFor(5).then(() => null),
		]);

		if (!data) {
			throw new Error();
		}

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
	if (index >= Configs.atomicEndpoints.length) {
		return [];
	}

	try {
		const endpoint = Configs.atomicEndpoints[index];
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

function makeRecoverAction(account, energy) {
	return {
		account: "farmersworld",
		name: "recover",
		authorization: [{ actor: account, permission: "active" }],
		data: { energy_recovered: energy, owner: account },
	};
}

async function recoverEnergy() {
	shuffleEndpoints();

	const { ACCOUNT_NAME, PRIVATE_KEY, RECOVER_THRESHOLD, MAX_FOOD_CONSUMPTION, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const maxConsumption = parseFloat(MAX_FOOD_CONSUMPTION) || 100;
	const threshold = parseFloat(RECOVER_THRESHOLD) || 50;

	console.log(`Fetching account ${cyan(ACCOUNT_NAME)}`);
	const [account] = await fetchAccount(ACCOUNT_NAME);

	if (!account) {
		console.log(`${red("Error")} Account ${cyan(ACCOUNT_NAME)} not found`);
		return;
	}

	const { energy, max_energy, balances } = account;
	const percentage = 100 * (energy / max_energy);

	if (percentage < threshold) {
		const foodBalance = parseFloat(balances.find(b => b.includes("FOOD"))) || 0;

		if (foodBalance < 0.2) {
			console.log(`${yellow("Warning")} Account ${cyan(ACCOUNT_NAME)} doesn't have food to recover energy`);
			return;
		}

		const energyNeeded = Math.min(max_energy - energy, Math.floor(Math.min(maxConsumption, foodBalance) * 5));
		const delay = _.round(_.random(delayMin, delayMax, true), 2);

		console.log(
			`\tRecovering ${yellow(energyNeeded)} energy`,
			`by consuming ${yellow(energyNeeded / 5)} FOOD`,
			`(energy ${yellow(energy)} / ${yellow(max_energy)})`,
			magenta(`(${_.round((energy / max_energy) * 100, 2)}%)`),
			`(after a ${Math.round(delay)}s delay)`
		);
		const actions = [makeRecoverAction(ACCOUNT_NAME, energyNeeded)];

		await waitFor(delay);
		await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
	}
}

async function repairTools() {
	shuffleEndpoints();

	const { ACCOUNT_NAME, PRIVATE_KEY, REPAIR_THRESHOLD, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const threshold = parseFloat(REPAIR_THRESHOLD) || 50;

	console.log(`Fetching tools for account ${cyan(ACCOUNT_NAME)}`);
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
			const toolInfo = Configs.tools.find(t => t.template_id == tool.template_id);

			const delay = _.round(_.random(delayMin, delayMax, true), 2);

			console.log(
				`\tRepairing`,
				`(${yellow(tool.asset_id)})`,
				green(`${toolInfo.rarity} ${toolInfo.template_name}`),
				`(durability ${yellow(tool.current_durability)} / ${yellow(tool.durability)})`,
				magenta(`(${_.round((tool.current_durability / tool.durability) * 100, 2)}%)`),
				`(after a ${Math.round(delay)}s delay)`
			);
			const actions = [makeToolRepairAction(ACCOUNT_NAME, tool.asset_id)];

			await waitFor(delay);
			await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
		}
	}
}

async function feedAnimals() {
	shuffleEndpoints();

	const { ACCOUNT_NAME, PRIVATE_KEY, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	console.log(`Fetching animals for account ${cyan(ACCOUNT_NAME)}`);
	const animals = await fetchAnimls(ACCOUNT_NAME);

	const feedables = animals.filter(({ next_availability }) => {
		const next = new Date(next_availability * 1e3);
		return next.getTime() < Date.now();
	});

	console.log(`Found ${yellow(animals.length)} animals / ${yellow(feedables.length)} animals ready to feed`);

	if (feedables.length > 0) {
		console.log(`Fetching food from account ${cyan(ACCOUNT_NAME)}`);
		const food = await fetchFood(ACCOUNT_NAME);
		console.log(`Found ${yellow(food.length)} food`);

		if (food.length) {
			if (feedables.length > food.length) {
				console.log(yellow("Warning: You don't have enough food to feed all your animals"));
			}

			console.log("Feeding Animals");

			for (let i = 0; i < feedables.length; i++) {
				const animal = feedables[i];
				const animalInfo = Configs.animals.find(t => t.template_id == animal.template_id);

				const foodItemIndex = [...food].findIndex(
					item => parseInt(item.template.template_id) == ANIMAL_FOOD[animal.template_id]
				);

				if (foodItemIndex == -1) {
					console.log(`\t${yellow("No compatible food found for")} ${green(animal.name)}`);
					continue;
				}

				const [foodItem] = [...food].splice(foodItemIndex, 1);
				const delay = _.round(_.random(delayMin, delayMax, true), 2);

				console.log(
					`\tFeeding animal`,
					`(${yellow(foodItem.asset_id)})`,
					green(`${animalInfo.name}`),
					`with ${foodItem.name} (${foodItem.asset_id})`,
					`(after a ${Math.round(delay)}s delay)`
				);
				const actions = [makeFeedingAction(ACCOUNT_NAME, animal.asset_id, foodItem.asset_id)];

				await waitFor(delay);
				await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
			}
		}
	}
}

async function claimCrops() {
	shuffleEndpoints();

	const { ACCOUNT_NAME, PRIVATE_KEY, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	console.log(`Fetching crops for account ${cyan(ACCOUNT_NAME)}`);
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

			const delay = _.round(_.random(delayMin, delayMax, true), 2);

			console.log(
				`\tClaiming crop`,
				`(${yellow(crop.asset_id)})`,
				green(`${crop.name}`),
				`(after a ${Math.round(delay)}s delay)`
			);
			const actions = [makeCropAction(ACCOUNT_NAME, crop.asset_id)];

			await waitFor(delay);
			await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
		}
	}
}

async function useTools() {
	shuffleEndpoints();

	const { ACCOUNT_NAME, PRIVATE_KEY, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	console.log(`Fetching tools for account ${cyan(ACCOUNT_NAME)}`);
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
			const toolInfo = Configs.tools.find(t => t.template_id == tool.template_id);

			const delay = _.round(_.random(delayMin, delayMax, true), 2);

			console.log(
				`\tClaiming with`,
				`(${yellow(tool.asset_id)})`,
				green(`${toolInfo.rarity} ${toolInfo.template_name}`),
				`(for ${green(tool.type)})`,
				`(after a ${Math.round(delay)}s delay)`
			);

			const actions = [makeToolClaimAction(ACCOUNT_NAME, tool.asset_id)];

			await waitFor(delay);
			await transact({ account: ACCOUNT_NAME, privKeys: [PRIVATE_KEY], actions });
		}
	}
}

async function runTasks() {
	await recoverEnergy();
	console.log(); // just for clarity

	await repairTools();
	console.log(); // just for clarity

	await useTools();
	console.log(); // just for clarity

	await claimCrops();
	console.log(); // just for clarity

	await feedAnimals();
	console.log(); // just for clarity
}

(async () => {
	const { ACCOUNT_NAME, PRIVATE_KEY, CHECK_INTERVAL } = process.env;
	const interval = parseInt(CHECK_INTERVAL) || 15;
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

	console.log(`Fetching Animal configurations`);
	Configs.animals = await fetchTable(null, "animals", 1);
	Configs.animals
		.filter(({ consumed_quantity }) => consumed_quantity > 0)
		.forEach(({ template_id, consumed_card }) => (ANIMAL_FOOD[template_id] = consumed_card));

	console.log(`Fetching Tool configurations`);
	Configs.tools = await fetchTable(null, "toolconfs", 1);

	console.log(`Running every ${interval} minutes`);
	console.log();

	runTasks();

	setInterval(() => runTasks(), interval * 60e3);
})();
