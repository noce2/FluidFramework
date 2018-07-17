import { ICommit, ICommitDetails } from "gitresources";
import * as moniker from "moniker";
import * as winston from "winston";
import * as api from "../api-core";
import * as core from "../core";
import * as utils from "../utils";

const StartingSequenceNumber = 0;

/**
 * Retrieves database details for the given document
 */
export async function getDocument(
    mongoManager: utils.MongoManager,
    documentsCollectionName: string,
    tenantId: string,
    documentId: string): Promise<any> {

    const db = await mongoManager.getDatabase();
    const collection = db.collection<any>(documentsCollectionName);
    return collection.findOne({ documentId, tenantId });
}

export async function getOrCreateDocument(
    mongoManager: utils.MongoManager,
    documentsCollectionName: string,
    tenantId: string,
    documentId: string): Promise<{existing: boolean, value: core.IDocument }> {

    const getOrCreateP = getOrCreateObject(
        mongoManager,
        documentsCollectionName,
        tenantId,
        documentId);

    return getOrCreateP;
}

export async function getLatestVersion(
    tenantManager: core.ITenantManager,
    tenantId: string,
    documentId: string): Promise<ICommitDetails> {

    return new Promise<ICommitDetails>((resolve, reject) => {
        getVersions(tenantManager, tenantId, documentId, 1).then((commits) => {
            if (commits.length > 0) {
                resolve(commits[0]);
            } else {
                resolve(null);
            }
        }, (err) => {
            reject(err);
        });
    });
}

export async function getVersions(
    tenantManager: core.ITenantManager,
    tenantId: string,
    documentId: string,
    count: number): Promise<ICommitDetails[]> {

    return new Promise<ICommitDetails[]>((resolve, reject) => {
        tenantManager.getTenant(tenantId).then((tenant) => {
            const gitManager = tenant.gitManager;
            gitManager.getCommits(documentId, count).then((commits) => {
                resolve(commits);
            }, (err) => {
                reject(err);
            });
        }, (error) => {
            reject(error);
        });
    });
}

export async function getVersion(
    tenantManager: core.ITenantManager,
    tenantId: string,
    documentId: string,
    sha: string): Promise<ICommit> {
    return new Promise<ICommit>((resolve, reject) => {
        tenantManager.getTenant(tenantId).then((tenant) => {
            const gitManager = tenant.gitManager;
            gitManager.getCommit(sha).then((commit) => {
                resolve(commit);
            }, (err) => {
                reject(err);
            });
        }, (error) => {
            reject(error);
        });
    });
}

/**
 * Retrieves the forks for the given document
 */
export async function getForks(
    mongoManager: utils.MongoManager,
    documentsCollectionName: string,
    tenantId: string,
    documentId: string): Promise<string[]> {

    const db = await mongoManager.getDatabase();
    const collection = db.collection<any>(documentsCollectionName);
    const document = await collection.findOne({ documentId, tenantId });

    return document.forks || [];
}

export async function createFork(
    producer: utils.IProducer,
    tenantManager: core.ITenantManager,
    mongoManager: utils.MongoManager,
    documentsCollectionName: string,
    tenantId: string,
    id: string): Promise<string> {

    const name = moniker.choose();
    const tenant = await tenantManager.getTenant(tenantId);

    // Load in the latest snapshot
    const gitManager = tenant.gitManager;
    const head = await gitManager.getRef(id);
    winston.info(JSON.stringify(head));

    let sequenceNumber: number;
    let minimumSequenceNumber: number;
    if (head === null) {
        // Set the Seq# and MSN# to StartingSequenceNumber
        minimumSequenceNumber = StartingSequenceNumber;
        sequenceNumber = StartingSequenceNumber;
    } else {
        // Create a new commit, referencing the ref head, but swap out the metadata to indicate the branch details
        const attributesContentP = gitManager.getContent(head.object.sha, ".attributes");
        const branchP = gitManager.upsertRef(name, head.object.sha);
        const [attributesContent] = await Promise.all([attributesContentP, branchP]);

        const attributesJson = Buffer.from(attributesContent.content, "base64").toString("utf-8");
        const attributes = JSON.parse(attributesJson) as api.IDocumentAttributes;
        minimumSequenceNumber = attributes.minimumSequenceNumber;
        sequenceNumber = attributes.sequenceNumber;
    }

    // Get access to Mongo to update the route tables
    const db = await mongoManager.getDatabase();
    const collection = db.collection<core.IDocument>(documentsCollectionName);

    // Insert the fork entry and update the parent to prep storage for both objects
    const insertFork = collection.insertOne(
        {
            branchMap: undefined,
            clients: undefined,
            createTime: Date.now(),
            documentId: name,
            forks: [],
            logOffset: undefined,
            parent: {
                documentId: id,
                minimumSequenceNumber,
                sequenceNumber,
                tenantId,
            },
            sequenceNumber,
            tenantId,
        });
    const updateParent = await collection.update(
        {
            documentId: id,
            tenantId,
        },
        null,
        {
            forks: { documentId: name, tenantId },
        });
    await Promise.all([insertFork, updateParent]);

    // Notify the parent branch of the fork and the desire to integrate changes
    await sendIntegrateStream(
        tenantId,
        id,
        sequenceNumber,
        minimumSequenceNumber,
        name,
        producer);

    return name;
}

async function getOrCreateObject(
    mongoManager: utils.MongoManager,
    documentsCollectionName: string,
    tenantId: string,
    documentId: string): Promise<{ existing: boolean, value: core.IDocument }> {

    const db = await mongoManager.getDatabase();
    const collection = db.collection<core.IDocument>(documentsCollectionName);
    const result = await collection.findOrCreate(
        {
            documentId,
            tenantId,
        },
        {
            branchMap: undefined,
            clients: undefined,
            createTime: Date.now(),
            documentId,
            forks: [],
            logOffset: undefined,
            parent: null,
            sequenceNumber: StartingSequenceNumber,
            tenantId,
        });

    return result;
}

/**
 * Sends a stream integration message which will forward messages after sequenceNumber from id to name.
 */
async function sendIntegrateStream(
    tenantId: string,
    id: string,
    sequenceNumber: number,
    minSequenceNumber: number,
    name: string,
    producer: utils.IProducer): Promise<void> {

    const contents: core.IForkOperation = {
        documentId: name,
        minSequenceNumber,
        sequenceNumber,
        tenantId,
    };

    const integrateMessage: core.IRawOperationMessage = {
        clientId: null,
        documentId: id,
        operation: {
            clientSequenceNumber: -1,
            contents,
            referenceSequenceNumber: -1,
            traces: [],
            type: api.Fork,
        },
        tenantId,
        timestamp: Date.now(),
        type: core.RawOperationType,
        user: null,
    };
    await producer.send(JSON.stringify(integrateMessage), id);
}
