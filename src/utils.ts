import { Address, AnchorProvider, BN, Program, web3 } from "@coral-xyz/anchor";
import { SPL_GOVERNANCE_IDL } from "./idl";
import { GOVERNANCE_PROGRAM_ID, GOVERNANCE_PROGRAM_SEED } from "./constants";
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

/**
 * Get a Transaction for creating a proposal.
 *
 * @param governanceProgram
 * @param realmKey
 * @param governanceKey
 * @param proposalName
 * @param councilVote
 * @returns
 */
export const createProposalTx = async (
  governanceProgram: Program<typeof SPL_GOVERNANCE_IDL>,
  realmKey: Address,
  governanceKey: Address,
  proposalName: string,
  councilVote = false
) => {
  const realm = await governanceProgram.account.realmV2.fetch(realmKey);
  if (!realm) {
    throw new Error("Could not fetch Realm V2 account");
  }
  const proposalSeed = new web3.Keypair().publicKey;
  const governingTokenMint = councilVote
    ? realm.config.councilMint
    : realm.communityMint;
  const [proposalAddress] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(GOVERNANCE_PROGRAM_SEED),
      new web3.PublicKey(governanceKey).toBuffer(),
      governingTokenMint.toBuffer(),
      proposalSeed.toBuffer(),
    ],
    GOVERNANCE_PROGRAM_ID
  );
  const [proposalOwnerRecordKey] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(GOVERNANCE_PROGRAM_SEED),
      new web3.PublicKey(realmKey).toBuffer(),
      governingTokenMint.toBuffer(),
      governanceProgram.provider.publicKey.toBuffer(),
    ],
    GOVERNANCE_PROGRAM_ID
  );
  const [realmConfigAddress] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("realm-config"), new web3.PublicKey(realmKey).toBuffer()],
    GOVERNANCE_PROGRAM_ID
  );
  const [proposalDepositAddress] = web3.PublicKey.findProgramAddressSync(
    [
      proposalAddress.toBuffer(),
      governanceProgram.provider.publicKey.toBuffer(),
    ],
    GOVERNANCE_PROGRAM_ID
  );

  const tx = await governanceProgram.methods
    .createProposal(
      proposalName,
      "",
      { singleChoice: {} },
      ["Approve"],
      true,
      proposalSeed
    )
    .accounts({
      realm: realmKey,
      proposalAddress,
      // governance comes from the `governedAccount` in the instructions (i.e. a treasury account)
      governance: governanceKey,
      // proposalOwnerRecord is the account for which the user created to deposit into spl governance?
      proposalOwnerRecord: proposalOwnerRecordKey,
      governanceAuthority: governanceProgram.provider.publicKey,
      payer: governanceProgram.provider.publicKey,
      governingTokenMint,
      systemProgram: web3.SystemProgram.programId,
      realmConfigAddress,
      proposalDepositAddress,
    })
    .transaction();

  return {
    tx,
    proposalAddress,
    proposalOwnerRecordKey,
  };
};

/**
 * Get a Transaction for inserting TransactionInstructions into a Proposal.
 *
 * @param governanceProgram
 * @param governanceKey
 * @param proposalAddress
 * @param proposalOwnerRecordKey
 * @param txIndex - must be incremented for each appended transaction in the proposal
 * @param instructions
 * @returns
 */
export const insertTransactionTx = async (
  governanceProgram: Program<typeof SPL_GOVERNANCE_IDL>,
  governanceKey: Address,
  proposalAddress: Address,
  proposalOwnerRecordKey: Address,
  txIndex: number,
  instructions: web3.TransactionInstruction[]
) => {
  const optionIndex = 0;
  const holdupTime = 0;

  const ixDataVec = instructions.map((ix) =>
    getInstructionDataFromInstruction(ix)
  );
  const [proposalTransactionAddress] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(GOVERNANCE_PROGRAM_SEED),
      new web3.PublicKey(proposalAddress).toBuffer(),
      new BN(optionIndex).toArrayLike(Buffer, "le", 1),
      new BN(txIndex).toArrayLike(Buffer, "le", 2),
    ],
    GOVERNANCE_PROGRAM_ID
  );

  return governanceProgram.methods
    .insertTransaction(optionIndex, txIndex, holdupTime, ixDataVec)
    .accounts({
      governance: governanceKey,
      proposal: proposalAddress,
      tokenOwnerRecord: proposalOwnerRecordKey,
      governanceAuthority: governanceProgram.provider.publicKey,
      proposalTransactionAddress,
      payer: governanceProgram.provider.publicKey,
      systemProgram: web3.SystemProgram.programId,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .transaction();
};

/**
 * Get the Transaction that finalizes the proposal, making it visible on Realms.
 *
 * @param governanceProgram
 * @param realmKey
 * @param governanceKey
 * @param proposalOwnerRecordKey
 * @param proposalAddress
 * @returns
 */
export const createProposalSignOffTx = async (
  governanceProgram: Program<typeof SPL_GOVERNANCE_IDL>,
  realmKey: Address,
  governanceKey: Address,
  proposalOwnerRecordKey: Address,
  proposalAddress: Address
) => {
  return governanceProgram.methods
    .signOffProposal()
    .accounts({
      realm: realmKey,
      governance: governanceKey,
      proposal: proposalAddress,
      signatory: governanceProgram.provider.publicKey,
      proposalOwnerRecord: proposalOwnerRecordKey,
    })
    .transaction();
};

/**
 * Create a single choice proposal with instructions to be executed.
 *
 * @param governanceProgram
 * @param realmKey
 * @param governanceKey
 * @param proposalName
 * @param instructions
 * @param councilVote
 * @returns
 */
export const createProposalWithInstructionsTransactions = async (
  governanceProgram: Program<typeof SPL_GOVERNANCE_IDL>,
  realmKey: Address,
  governanceKey: Address,
  proposalName: string,
  instructions: web3.TransactionInstruction[],
  councilVote = false,
) => {
  const realm = await governanceProgram.account.realmV2.fetch(realmKey);
  if (!realm) {
    throw new Error("Could not fetch Realm V2 account");
  }
  const proposalSeed = new web3.Keypair().publicKey;
  const governingTokenMint = councilVote
    ? realm.config.councilMint
    : realm.communityMint;
  const [proposalAddress] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(GOVERNANCE_PROGRAM_SEED),
      new web3.PublicKey(governanceKey).toBuffer(),
      governingTokenMint.toBuffer(),
      proposalSeed.toBuffer(),
    ],
    GOVERNANCE_PROGRAM_ID
  );
  const [proposalOwnerRecordKey] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(GOVERNANCE_PROGRAM_SEED),
      new web3.PublicKey(realmKey).toBuffer(),
      governingTokenMint.toBuffer(),
      governanceProgram.provider.publicKey.toBuffer(),
    ],
    GOVERNANCE_PROGRAM_ID
  );
  const [realmConfigAddress] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("realm-config"), new web3.PublicKey(realmKey).toBuffer()],
    GOVERNANCE_PROGRAM_ID
  );
  const [proposalDepositAddress] = web3.PublicKey.findProgramAddressSync(
    [
      proposalAddress.toBuffer(),
      governanceProgram.provider.publicKey.toBuffer(),
    ],
    GOVERNANCE_PROGRAM_ID
  );

  const optionIndex = 0;
  const holdupTime = 0;
  const txIndex = 0;
  const ixDataVec = instructions.map((ix) =>
    getInstructionDataFromInstruction(ix)
  );
  const [proposalTransactionAddress] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(GOVERNANCE_PROGRAM_SEED),
      proposalAddress.toBuffer(),
      new BN(optionIndex).toArrayLike(Buffer, "le", 1),
      new BN(txIndex).toArrayLike(Buffer, "le", 2),
    ],
    GOVERNANCE_PROGRAM_ID
  );

  return Promise.all([
    // TX 1: Create the proposal
    governanceProgram.methods
      .createProposal(
        proposalName,
        "",
        { singleChoice: {} },
        ["Approve"],
        true,
        proposalSeed
      )
      .accounts({
        realm: realmKey,
        proposalAddress,
        // governance comes from the `governedAccount` in the instructions (i.e. a treasury account)
        governance: governanceKey,
        // proposalOwnerRecord is the account for which the user created to deposit into spl governance?
        proposalOwnerRecord: proposalOwnerRecordKey,
        governanceAuthority: governanceProgram.provider.publicKey,
        payer: governanceProgram.provider.publicKey,
        governingTokenMint,
        systemProgram: web3.SystemProgram.programId,
        realmConfigAddress,
        proposalDepositAddress,
      })
      .transaction(),
    // TX 2: Insert the instructions TX to the proposal
    governanceProgram.methods
      .insertTransaction(optionIndex, txIndex, holdupTime, ixDataVec)
      .accounts({
        governance: governanceKey,
        proposal: proposalAddress,
        tokenOwnerRecord: proposalOwnerRecordKey,
        governanceAuthority: governanceProgram.provider.publicKey,
        proposalTransactionAddress,
        payer: governanceProgram.provider.publicKey,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .transaction(),
    // TX 3: Sign off on the proposal to show up in the governance UI
    governanceProgram.methods
      .signOffProposal()
      .accounts({
        realm: realmKey,
        governance: governanceKey,
        proposal: proposalAddress,
        signatory: governanceProgram.provider.publicKey,
        proposalOwnerRecord: proposalOwnerRecordKey,
      })
      .transaction(),
  ]);
};
