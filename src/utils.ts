import { AnchorProvider, Program, web3 } from "@coral-xyz/anchor";
import { SPL_GOVERNANCE_IDL } from "./idl";
import { GOVERNANCE_PROGRAM_ID } from "./constants";
import { SplGovernanceCoder } from "./coder";

interface AnchorWallet {
  publicKey: web3.PublicKey;
  signTransaction<T extends web3.Transaction | web3.VersionedTransaction>(
    transaction: T
  ): Promise<T>;
  signAllTransactions<T extends web3.Transaction | web3.VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]>;
}

/**
 * Create the Anchor Program instance for SPL Governance
 * @param wallet
 * @param connection
 * @param programId
 * @returns
 */
export const createSplGovernanceProgram = (
  wallet: AnchorWallet,
  connection: web3.Connection,
  programId = GOVERNANCE_PROGRAM_ID
) => {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  return new Program(
    SPL_GOVERNANCE_IDL,
    programId,
    provider,
    new SplGovernanceCoder(SPL_GOVERNANCE_IDL)
  );
};

export const getInstructionDataFromInstruction = (
  instruction: web3.TransactionInstruction
) => {
  return {
    programId: instruction.programId,
    accounts: instruction.keys,
    data: instruction.data,
  };
};
