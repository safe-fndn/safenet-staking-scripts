import type { Statement } from "better-sqlite3";
import { type Address, getAbiItem, getAddress, type Hex, hashTypedData, isHex } from "viem";
import { z } from "zod";
import { CONSENSUS_ABI } from "../abi.js";
import { checkTransaction } from "../checks/index.js";
import { jsonPreprocessor, jsonReplacer } from "../utils/json.js";
import type { BlockRange, TimestampRange } from "../utils/ranges.js";
import { type Configuration, EventIndexer, type ParsedLog } from "./events.js";
import type { Packet } from "./signatures.js";

const EVENTS = [
	getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionProposed" }),
	getAbiItem({ abi: CONSENSUS_ABI, name: "TransactionAttested" }),
];

export type TimestampedPacket = Packet & { timestamp: bigint };

const METATX_SCHEMA = z.object({
	safe: z.string().transform((a) => getAddress(a)),
	to: z.string().transform((a) => getAddress(a)),
	value: z.coerce.bigint().nonnegative(),
	operation: z.union([z.literal(0), z.literal(1)]),
	data: z
		.string()
		.refine((h) => isHex(h))
		.transform((h) => h as Hex),
});

type TransactionProposal = {
	message: Hex;
	blockNumber: bigint;
	transaction: string;
};

type TransactionAttestation = {
	message: Hex;
	blockNumber: bigint;
	attestation: Hex;
};

type Transaction = {
	message: Hex;
	blockNumber: number;
	transaction: string;
	attestation: Hex | null;
};

export class Transactions extends EventIndexer<typeof EVENTS> {
	#domain: {
		chainId: number;
		verifyingContract: Address;
	};
	#queries: {
		upsertTransactionProposal: Statement<TransactionProposal, number>;
		upsertTransactionAttestation: Statement<TransactionAttestation, number>;
		selectTransactionBlocks: Statement<BlockRange, number>;
		selectTransactions: Statement<BlockRange, Transaction>;
	};

	constructor(config: Configuration) {
		super({
			name: "transactions",
			events: EVENTS,
			...config,
		});

		this.#domain = {
			chainId: config.chainId,
			verifyingContract: config.address,
		};

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS transactions(
				contract TEXT NOT NULL,
				message TEXT NOT NULL,
				block_number INTEGER NOT NULL,
				"transaction" TEXT,
				attestation TEXT,
				PRIMARY KEY(contract, message)
			);
			CREATE INDEX IF NOT EXISTS transactions_block_number_idx
			ON transactions(block_number);
		`);
		this.#queries = {
			upsertTransactionProposal: this.db.prepare<TransactionProposal, number>(`
				INSERT INTO transactions(contract, message, block_number, "transaction", attestation)
				VALUES('${this.contract}', @message, @blockNumber, @transaction, NULL)
				ON CONFLICT(contract, message)
				DO UPDATE SET block_number = EXCLUDED.block_number
				, "transaction" = EXCLUDED."transaction"
			`),
			upsertTransactionAttestation: this.db.prepare<TransactionAttestation, number>(`
				INSERT INTO transactions(contract, message, block_number, "transaction", attestation)
				VALUES('${this.contract}', @message, @blockNumber, NULL, @attestation)
				ON CONFLICT(contract, message)
				DO UPDATE SET attestation = EXCLUDED.attestation
			`),
			selectTransactionBlocks: this.db.prepare<BlockRange, number>(`
				SELECT DISTINCT(block_number)
				FROM transactions
				WHERE contract = '${this.contract}'
				AND block_number >= @fromBlock
				AND block_number <= @toBlock
				AND "transaction" IS NOT NULL
			`),
			selectTransactions: this.db.prepare<BlockRange, Transaction>(`
				SELECT message
				, block_number as blockNumber
				, "transaction"
				, attestation
				FROM transactions
				WHERE contract = '${this.contract}'
				AND block_number >= @fromBlock
				AND block_number <= @toBlock
				AND "transaction" IS NOT NULL
			`),
		};
	}

	protected insertEvent(log: ParsedLog<typeof EVENTS>): void {
		const message = hashTypedData({
			domain: this.#domain,
			types: {
				TransactionProposal: [
					{ name: "epoch", type: "uint64" },
					{ name: "safeTxHash", type: "bytes32" },
				],
			},
			primaryType: "TransactionProposal",
			message: {
				epoch: log.args.epoch,
				safeTxHash: log.args.safeTxHash,
			},
		});

		switch (log.eventName) {
			case "TransactionProposed": {
				this.#queries.upsertTransactionProposal.run({
					message,
					blockNumber: log.blockNumber,
					transaction: JSON.stringify(log.args.transaction, jsonReplacer),
				});
				break;
			}
			case "TransactionAttested": {
				this.#queries.upsertTransactionAttestation.run({
					message,
					blockNumber: log.blockNumber,
					attestation: log.args.signatureId,
				});
				break;
			}
		}
	}

	async *packets(period: TimestampRange): AsyncGenerator<TimestampedPacket> {
		const range = await this.blocks.blockRange(period);

		// Prefetch missing block timestamps for the range. We will need these
		// for computing determining the timestamp of the transaction proposal
		// to know which signers actually count for participation, and cannot
		// update the cache while we are iterating over results.
		const blocks = this.#queries.selectTransactionBlocks.pluck().all(range);
		for (const block of blocks) {
			await this.blocks.mustGetTimestamp({ blockNumber: BigInt(block) });
		}

		const transactions = this.#queries.selectTransactions.iterate(range);
		for (const { message, blockNumber, transaction, attestation } of transactions) {
			const meta = z.preprocess(jsonPreprocessor, METATX_SCHEMA).parse(transaction);
			const timestamp = await this.blocks.mustGetTimestamp({ blockNumber: BigInt(blockNumber) });
			yield {
				message,
				valid: checkTransaction(meta),
				attestation: attestation ?? undefined,
				timestamp,
			};
		}
	}
}
