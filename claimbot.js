const axios = require("axios");
const { cyan, green, magenta, red, yellow } = require("chalk");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const _ = require("lodash");
const nodeFetch = require("node-fetch");
const { TextDecoder, TextEncoder } = require("util");

require("dotenv").config();

const fetch = (url, payload) =>
	nodeFetch(url, {
		...payload,
		headers: { "User-Agent": "farmersbot/1.0.0" },
	});

const WAX_ENDPOINTS = _.shuffle([
	"https://api.wax.greeneosio.com",
	"https://api.waxsweden.org",
	"https://wax.cryptolions.io",
	"https://wax.eu.eosamsterdam.net",
	// "https://api-wax.eosarabia.net",
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
	autoWithdraw: false,
	withdrawThresholds: [],
	maxWithdraw: [],

	autoDeposit: false,
	depositThresholds: [],
	maxDeposit: [],

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

function parseRemainingTime(millis) {
	const diff = Math.floor(millis / 1e3);
	const hours = Math.floor(diff / 3600);
	const minutes = Math.floor((diff % 3600) / 60);
	const seconds = Math.floor((diff % 3600) % 60);
	const time = [
		hours > 0 && `${hours.toString().padStart(2, "0")} hours`,
		minutes > 0 && `${minutes.toString().padStart(2, "0")} minutes`,
		seconds > 0 && `${seconds.toString().padStart(2, "0")} seconds`,
	]
		.filter(n => !!n)
		.join(", ");

	return time;
}

function logTask(...message) {
	console.log(`${yellow("Task")}`, ...message);
	console.log("-".repeat(32));
}

async function transact(config) {
	const { DEV_MODE } = process.env;
	if (DEV_MODE == 1) {
		return;
	}

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

async function fetchTable(contract, table, scope, bounds, tableIndex, index = 0) {
	if (index >= Configs.WAXEndpoints.length) {
		return [];
	}

	try {
		const endpoint = Configs.WAXEndpoints[index];
		const rpc = new JsonRpc(endpoint, { fetch });

		const data = await Promise.race([
			rpc.get_table_rows({
				json: true,
				code: contract,
				scope: scope,
				table: table,
				lower_bound: bounds,
				upper_bound: bounds,
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
		return await fetchTable(contract, table, scope, bounds, tableIndex, index + 1);
	}
}

async function fetchCrops(account) {
	return await fetchTable("farmersworld", "crops", "farmersworld", account, 2);
}

async function fetchTools(account) {
	const tools = await fetchTable("farmersworld", "tools", "farmersworld", account, 2);
	return _.orderBy(tools, ["template_id", "next_availability"], ["asc", "asc"]);
}

async function fetchAccount(account) {
	return await fetchTable("farmersworld", "accounts", "farmersworld", account, 1);
}

async function fetchAnimls(account) {
	const animals = await fetchTable("farmersworld", "animals", "farmersworld", account, 2);
	return _.orderBy(animals, "template_id");
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
		data: { asset_ids: [foodId], from: account, memo: `feed_animal:${animalId}`, to: "farmersworld" },
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

function makeWithdrawAction(account, quantities, fee) {
	return {
		account: "farmersworld",
		name: "withdraw",
		authorization: [{ actor: account, permission: "active" }],
		data: { owner: account, quantities, fee },
	};
}

function makeDepositAction(account, quantities) {
	return {
		account: "farmerstoken",
		name: "transfers",
		authorization: [{ actor: account, permission: "active" }],
		data: { from: account, to: "farmersworld", quantities, memo: "deposit" },
	};
}

async function recoverEnergy(account, privKey) {
	shuffleEndpoints();

	const { RECOVER_THRESHOLD, MAX_FOOD_CONSUMPTION, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const maxConsumption = parseFloat(MAX_FOOD_CONSUMPTION) || 100;
	const threshold = parseFloat(RECOVER_THRESHOLD) || 50;

	logTask(`Recovering Energy`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	const { energy, max_energy, balances } = accountInfo;
	const percentage = 100 * (energy / max_energy);

	if (percentage > threshold) {
		console.log(
			`${yellow("Info")}`,
			`Account ${cyan(account)} doesn't need to recover`,
			`(energy ${yellow(energy)} / ${yellow(max_energy)})`,
			magenta(`(${_.round((energy / max_energy) * 100, 2)}%)`)
		);
		return;
	}

	const foodBalance = parseFloat(balances.find(b => b.includes("FOOD"))) || 0;

	if (foodBalance < 0.2) {
		console.log(`${yellow("Warning")} Account ${cyan(account)} doesn't have food to recover energy`);
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
	const actions = [makeRecoverAction(account, energyNeeded)];

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function repairTools(account, privKey) {
	shuffleEndpoints();

	const { REPAIR_THRESHOLD, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const threshold = parseFloat(REPAIR_THRESHOLD) || 50;

	logTask(`Repairing Tools`);
	console.log(`Fetching tools for account ${cyan(account)}`);
	const tools = await fetchTools(account);

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
				green(toolInfo.template_name),
				`(durability ${yellow(tool.current_durability)} / ${yellow(tool.durability)})`,
				magenta(`(${_.round((tool.current_durability / tool.durability) * 100, 2)}%)`),
				`(after a ${Math.round(delay)}s delay)`
			);
			const actions = [makeToolRepairAction(account, tool.asset_id)];

			await waitFor(delay);
			await transact({ account, privKeys: [privKey], actions });
		}
	}
}

async function feedAnimals(account, privKey) {
	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Feeding Animals`);
	console.log(`Fetching animals for account ${cyan(account)}`);
	const animals = await fetchAnimls(account);

	const feedables = animals.filter(({ next_availability }) => {
		const next = new Date(next_availability * 1e3);
		return next.getTime() < Date.now();
	});

	console.log(`Found ${yellow(animals.length)} animals / ${yellow(feedables.length)} animals ready to feed`);

	if (feedables.length > 0) {
		console.log(`Fetching food from account ${cyan(account)}`);
		const food = await fetchFood(account);
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

				const [foodItem] = food.splice(foodItemIndex, 1);
				const delay = _.round(_.random(delayMin, delayMax, true), 2);

				console.log(
					`\tFeeding animal`,
					`(${yellow(animal.asset_id)})`,
					green(`${animalInfo.name}`),
					`with ${foodItem.name} (${yellow(foodItem.asset_id)})`,
					`(after a ${Math.round(delay)}s delay)`
				);
				const actions = [makeFeedingAction(account, animal.asset_id, foodItem.asset_id)];

				await waitFor(delay);
				await transact({ account, privKeys: [privKey], actions });
			}
		}
	}
}

async function claimCrops(account, privKey) {
	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Claiming Crops`);
	console.log(`Fetching crops for account ${cyan(account)}`);
	const crops = await fetchCrops(account);

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
			const actions = [makeCropAction(account, crop.asset_id)];

			await waitFor(delay);
			await transact({ account, privKeys: [privKey], actions });
		}
	}
}

async function useTools(account, privKey) {
	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Using Tools`);
	console.log(`Fetching tools for account ${cyan(account)}`);
	const tools = await fetchTools(account);

	console.log(`Found ${yellow(tools.length)} tools`);

	for (let i = 0; i < tools.length; i++) {
		const tool = tools[i];
		const toolInfo = Configs.tools.find(t => t.template_id == tool.template_id);

		const nextClaim = new Date(tool.next_availability * 1e3);
		if (nextClaim.getTime() > Date.now()) {
			console.log(
				`\t${yellow("Notice")} Tool`,
				`(${yellow(tool.asset_id)})`,
				green(toolInfo.template_name),
				`still in cooldown period`,
				yellow(parseRemainingTime(nextClaim.getTime() - Date.now()))
			);
			continue;
		}

		if (toolInfo.durability_consumed >= tool.current_durability) {
			console.log(
				`\t${yellow("Warning")} Tool`,
				`(${yellow(tool.asset_id)})`,
				green(toolInfo.template_name),
				`does not have enough durability`,
				`(durability ${yellow(tool.current_durability)} / ${yellow(tool.durability)})`
			);
			continue;
		}

		const delay = _.round(_.random(delayMin, delayMax, true), 2);

		console.log(
			`\tClaiming with`,
			`(${yellow(tool.asset_id)})`,
			green(toolInfo.template_name),
			`(durability ${yellow(tool.current_durability)} / ${yellow(tool.durability)})`,
			magenta(`(${_.round((tool.current_durability / tool.durability) * 100, 2)}%)`),
			`(after a ${Math.round(delay)}s delay)`
		);

		const actions = [makeToolClaimAction(account, tool.asset_id)];

		await waitFor(delay);
		await transact({ account, privKeys: [privKey], actions });
	}
}

async function withdrawTokens(account, privKey) {
	if (!Configs.autoWithdraw) {
		return;
	}

	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Withdrawing Tokens`);
	console.log(`Fetching config table`);
	const [config] = await fetchTable("farmersworld", "config", "farmersworld", null, 1);

	const { min_fee, fee } = config;

	if (fee > min_fee) {
		console.log(
			`${yellow("Warning")}`,
			`Withdraw fee ${magenta(`(${fee}%)`)} is greater than the minimum fee ${magenta(`(${min_fee}%)`)}`,
			`aborting until next round`
		);
		return;
	}

	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	const { balances } = accountInfo;

	const withdrawables = balances
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }))
		.filter(token => {
			const threshold = Configs.withdrawThresholds.find(t => t.symbol == token.symbol);
			return threshold && token.amount >= threshold.amount;
		})
		.map(({ amount, symbol }) => {
			const max = Configs.maxWithdraw.find(t => t.symbol == symbol);
			return { amount: Math.min(amount, (max && max.amount) || Infinity), symbol };
		})
		.map(
			({ amount, symbol }) =>
				`${amount.toLocaleString("en", {
					useGrouping: false,
					minimumFractionDigits: 4,
					maximumFractionDigits: 4,
				})} ${symbol}`
		);

	if (!withdrawables.length) {
		console.log(`${yellow("Warning")}`, `Not enough tokens to auto-withdraw`, yellow(balances.join(", ")));
		return;
	}

	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	console.log(`\tWithdrawing ${yellow(withdrawables.join(", "))}`, `(after a ${Math.round(delay)}s delay)`);
	const actions = [makeWithdrawAction(account, withdrawables, fee)];

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function depositTokens(account, privKey) {
	if (!Configs.autoDeposit) {
		return;
	}

	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Depositing Tokens`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	console.log(`Fetching balances for account ${cyan(account)}`);
	const rows = await fetchTable("farmerstoken", "accounts", account, null, 1);
	const rawAccountBalances = rows.map(r => r.balance);
	const { balances: rawGameBalances } = accountInfo;

	const [accountBalances, gameBalances] = [rawAccountBalances, rawGameBalances].map(bals =>
		bals.map(t => t.split(/\s+/gi)).map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }))
	);

	const meetThreshold = gameBalances.filter(token => {
		const threshold = Configs.depositThresholds.find(t => t.symbol == token.symbol);
		return threshold && token.amount < threshold.amount;
	});

	if (!meetThreshold.length) {
		console.log(`${cyan("Info")}`, `No token deposit is needed`, yellow(rawGameBalances.join(", ")));
		return;
	}

	const elligibleTokens = meetThreshold
		.map(({ symbol }) => accountBalances.find(t => t.symbol == `FW${symbol.slice(0, 1)}`))
		.filter(b => !!b)
		.filter(({ amount }) => amount > 0);

	if (!elligibleTokens.length) {
		console.log(`${yellow("Warning")}`, `No token deposit is possible`, yellow(rawAccountBalances.join(", ")));
		return;
	}

	const depositables = elligibleTokens
		.map(({ amount, symbol }) => {
			const max = Configs.maxDeposit.find(t => t.symbol == symbol);
			return { amount: Math.min(amount, (max && max.amount) || Infinity), symbol };
		})
		.map(
			({ amount, symbol }) =>
				`${amount.toLocaleString("en", {
					useGrouping: false,
					minimumFractionDigits: 4,
					maximumFractionDigits: 4,
				})} ${symbol}`
		);

	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	console.log(`\tDepositing ${yellow(depositables.join(", "))}`, `(after a ${Math.round(delay)}s delay)`);
	const actions = [makeDepositAction(account, depositables)];

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function runTasks(account, privKey) {
	await depositTokens(account, privKey);
	console.log(); // just for clarity

	await recoverEnergy(account, privKey);
	console.log(); // just for clarity

	await repairTools(account, privKey);
	console.log(); // just for clarity

	await useTools(account, privKey);
	console.log(); // just for clarity

	await claimCrops(account, privKey);
	console.log(); // just for clarity

	await feedAnimals(account, privKey);
	console.log(); // just for clarity

	await withdrawTokens(account, privKey);
	console.log(); // just for clarity
}

async function runAccounts(accounts) {
	for (let i = 0; i < accounts.length; i++) {
		const { account, privKey } = accounts[i];
		await runTasks(account, privKey);
	}
}

(async () => {
	console.log(`FW Bot initialization`);

	const accounts = Object.entries(process.env)
		.map(([k, v]) => {
			if (k.startsWith("ACCOUNT_NAME")) {
				const id = k.replace("ACCOUNT_NAME", "");
				const key = process.env[`PRIVATE_KEY${id}`];
				if (!key) {
					console.log(red(`Account ${v} does not have a PRIVATE_KEY${id} in .env`));
					return;
				}

				try {
					// checking if key is valid
					PrivateKey.fromString(key).toLegacyString();
				} catch (error) {
					console.log(red(`PRIVATE_KEY${id} is not a valid EOS key`));
					return;
				}

				return { account: v, privKey: key };
			}

			return null;
		})
		.filter(acc => !!acc);

	const { CHECK_INTERVAL } = process.env;
	const { AUTO_WITHDRAW, WITHDRAW_THRESHOLD, MAX_WITHDRAW } = process.env;
	const { AUTO_DEPOSIT, DEPOSIT_THRESHOLD, MAX_DEPOSIT } = process.env;

	const interval = parseInt(CHECK_INTERVAL) || 15;

	Configs.autoWithdraw = AUTO_WITHDRAW == 1;
	Configs.withdrawThresholds = WITHDRAW_THRESHOLD.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	Configs.maxWithdraw = MAX_WITHDRAW.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	Configs.autoDeposit = AUTO_DEPOSIT == 1;
	Configs.depositThresholds = DEPOSIT_THRESHOLD.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	Configs.maxDeposit = MAX_DEPOSIT.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	console.log(`Fetching Animal configurations`);
	Configs.animals = await fetchTable("farmersworld", "anmconf", "farmersworld", null, 1);
	Configs.animals
		.filter(({ consumed_quantity }) => consumed_quantity > 0)
		.forEach(({ template_id, consumed_card }) => (ANIMAL_FOOD[template_id] = consumed_card));

	console.log(`Fetching Tool configurations`);
	Configs.tools = await fetchTable("farmersworld", "toolconfs", "farmersworld", null, 1);

	console.log(`FW Bot running for ${accounts.map(acc => cyan(acc.account)).join(", ")}`);
	console.log(`Running every ${interval} minutes`);
	console.log();

	runAccounts(accounts);

	setInterval(() => runAccounts(accounts), interval * 60e3);
})();
