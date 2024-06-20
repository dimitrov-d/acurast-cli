import "@polkadot/api-augment";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { uploadScript } from "./uploadToIpfs.js";
import { getEnv } from "../config.js";
import {
  AcurastProjectConfig,
  AssignmentStrategyVariant,
  JobRegistration,
} from "../types.js";
import { convertConfigToJob } from "./convertConfigToJob.js";

const RPC = "wss://canarynet-ws-1.acurast-h-server-2.papers.tech";

export enum DeploymentStatus {
  Uploaded = "Uploaded",
  Prepared = "Prepared",
  Submit = "Submit",
  WaitingForMatch = "WaitingForMatch",
  Matched = "Matched",
  Acknowledged = "Acknowledged",
  EnvironmentVariablesSet = "EnvironmentVariablesSet",
  Started = "Started",
  ExecutionDone = "ExecutionDone",
  Finalized = "Finalized",
}

async function registerJob(
  api: ApiPromise,
  injector: KeyringPair,
  job: JobRegistration,
  statusCallback: (
    status: DeploymentStatus,
    data?: JobRegistration | any
  ) => void
): Promise<string> {
  const script = `0x${Buffer.from(
    new TextEncoder().encode(job.script)
  ).toString("hex")}`;
  return new Promise(async (resolve, reject) => {
    const jobRegistration = api.createType("AcurastCommonJobRegistration", {
      script: api.createType("Bytes", script),
      allowedSources: job.allowedSources
        ? api.createType("Option<Vec<AccountId>>", job.allowedSources)
        : api.createType("Option<Vec<AccountId>>", undefined),
      allowOnlyVerifiedSources: job.allowOnlyVerifiedSources,
      schedule: {
        duration: api.createType("u64", job.schedule.duration),
        startTime: api.createType("u64", job.schedule.startTime),
        endTime: api.createType("u64", job.schedule.endTime),
        interval: api.createType("u64", job.schedule.interval),
        maxStartDelay: api.createType("u64", job.schedule.maxStartDelay),
      },
      memory: api.createType("u32", job.memory),
      networkRequests: api.createType("u32", job.networkRequests),
      storage: api.createType("u32", job.storage),
      requiredModules: api.createType(
        "Vec<AcurastCommonJobModule>",
        job.requiredModules ?? []
      ),
      extra: api.createType("PalletAcurastMarketplaceRegistrationExtra", {
        requirements: api.createType(
          "PalletAcurastMarketplaceJobRequirements",
          {
            assignmentStrategy:
              job.extra.requirements.assignmentStrategy.variant ==
              AssignmentStrategyVariant.Single
                ? api.createType("PalletAcurastMarketplaceAssignmentStrategy", {
                    single: job.extra.requirements.assignmentStrategy
                      .instantMatch
                      ? api.createType(
                          "Option<Vec<PalletAcurastMarketplacePlannedExecution>>",
                          job.extra.requirements.assignmentStrategy.instantMatch.map(
                            (item) => ({
                              source: api.createType("AccountId", item.source),
                              startDelay: api.createType(
                                "u64",
                                item.startDelay.toFixed()
                              ),
                            })
                          )
                        )
                      : api.createType("Option<bool>", undefined),
                  })
                : api.createType("PalletAcurastMarketplaceAssignmentStrategy", {
                    competing: "",
                  }),
            slots: api.createType("u8", job.extra.requirements.slots),
            reward: api.createType("u128", job.extra.requirements.reward),
            minReputation: job.extra.requirements.minReputation
              ? api.createType(
                  "Option<u128>",
                  job.extra.requirements.minReputation
                )
              : api.createType("Option<u128>", undefined),
            instantMatch: job.extra.requirements.instantMatch
              ? api.createType(
                  "Option<Vec<PalletAcurastMarketplacePlannedExecution>>",
                  job.extra.requirements.instantMatch.map((item: any) => ({
                    source: api.createType("AccountId", item.source),
                    startDelay: api.createType("u64", item.startDelay),
                  }))
                )
              : api.createType("Option<bool>", undefined),
          }
        ),
        // expectedFulfillmentFee: api.createType(
        //   "u128",
        //   job.extra.expectedFulfillmentFee
        // ),
      }),
    });
    try {
      const unsub = await api.tx["acurast"]
        ["register"](jobRegistration)
        .signAndSend(injector, ({ status, events, txHash, dispatchError }) => {
          // console.log(
          //   "Transaction status:",
          //   status.type,
          //   status.isFinalized,
          //   status.isInBlock,
          //   status.isBroadcast,
          //   txHash.toHex()
          // );
          const jobRegistrationEvents = events.filter((event) => {
            return (
              event.event.section === "acurast" &&
              event.event.method === "JobRegistrationStored"
            );
          });
          const jobIds = jobRegistrationEvents.map((jobRegistrationEvent) => {
            return jobRegistrationEvent.event.data[1];
          });

          // console.log("jobIds", jobIds);
          if (jobIds.length > 0) {
            statusCallback(DeploymentStatus.WaitingForMatch, {
              jobIds: jobIds.map((jobId) => jobId.toHuman()),
            });
            api.query.acurastMarketplace.storedJobStatus.multi(
              jobIds,
              (statuses) => {
                // console.log("STATUS CB");
                const stat = api.registry.createType(
                  "Vec<Option<PalletAcurastMarketplaceJobStatus>>",
                  statuses
                );
                const result = stat
                  .map((value, index) => {
                    if (value.isSome) {
                      const statusValue = value.unwrap() as any;
                      let status = "Open";
                      if (statusValue.isMatched) {
                        statusCallback(DeploymentStatus.Matched);
                        status = "Matched";
                      } else if (statusValue.isAssigned) {
                        statusCallback(DeploymentStatus.Acknowledged, {
                          acknowledged: statusValue.asAssigned.toNumber(),
                        });
                        status = JSON.stringify({
                          assigned: statusValue.asAssigned.toNumber(),
                        });
                      }
                      return {
                        id: jobIds[index],
                        status,
                      };
                    }
                    return undefined;
                  })
                  .filter((value) => value !== undefined);

                // console.log("result", result);

                // console.log(
                //   "statuses",
                //   statuses.map((status) => status.toHuman())
                // );
              }
            );
          }

          if (status.isInBlock || status.isFinalized) {
            unsub();
          }

          if (dispatchError) {
            if (dispatchError.isModule) {
              // for module errors, we have the section indexed, lookup
              const decoded = api.registry.findMetaError(
                dispatchError.asModule
              );
              const { docs, name, section } = decoded;

              reject(`${section}.${name}: ${docs.join(" ")}`);
            } else {
              // Other, CannotLookup, BadOrigin, no extra info
              reject(dispatchError.toHuman() || dispatchError.toString());
            }
          } else if (status.isInBlock) {
            resolve(txHash.toHex());
          }
        });
    } catch (e) {
      reject(e);
    }
  });
}

export const createJob = async (
  config: AcurastProjectConfig,
  statusCallback: (
    status: DeploymentStatus,
    data?: JobRegistration | any
  ) => void
) => {
  const wsProvider = new WsProvider(RPC);
  const api = await ApiPromise.create({
    provider: wsProvider,
    noInitWarn: true,
  });

  const keyring = new Keyring({ type: "sr25519" });
  const wallet = keyring.addFromMnemonic(getEnv("ACURAST_MNEMONIC"), {
    name: "AcurastCli",
  });

  const ipfsHash = await uploadScript({ file: config.fileUrl });

  statusCallback(DeploymentStatus.Uploaded, { ipfsHash });
  config.fileUrl = ipfsHash;

  const job = convertConfigToJob(config);

  statusCallback(DeploymentStatus.Prepared, { job });

  const result = await registerJob(api, wallet, job, statusCallback);

  statusCallback(DeploymentStatus.Submit, { txHash: result });
};
