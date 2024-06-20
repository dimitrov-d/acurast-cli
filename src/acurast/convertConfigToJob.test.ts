import {
  DEFAULT_REWARD,
  convertConfigToJob,
} from "../acurast/convertConfigToJob.js";
import {
  AcurastProjectConfig,
  AssignmentStrategyVariant,
  JobRegistration,
} from "../types.js";

describe("convertConfigToJob", () => {
  test("should convert config to job registration with one-time execution", () => {
    const config: AcurastProjectConfig = {
      projectName: "test",
      fileUrl: "./examples/ip.js",
      network: "canary",
      onlyAttestedDevices: true,
      assignmentStrategy: { type: AssignmentStrategyVariant.Single },
      execution: {
        type: "onetime",
        maxExecutionTimeInMs: 5000,
      },
      usageLimit: {
        maxMemory: 0,
        maxNetworkRequests: 0,
        maxStorage: 0,
      },
      maxAllowedStartDelayInMs: 0,
      numberOfReplicas: 1,
      minProcessorReputation: 0,
      maxCostPerExecution: DEFAULT_REWARD,
    };

    const expectedJobRegistration: JobRegistration = {
      script: "https://example.com/script.js",
      allowedSources: undefined,
      allowOnlyVerifiedSources: false,
      schedule: {
        duration: 5000,
        startTime: expect.any(Number),
        endTime: expect.any(Number),
        interval: expect.any(Number),
        maxStartDelay: 10000,
      },
      memory: 512,
      networkRequests: 10,
      storage: 100,
      requiredModules: ["module1", "module2"],
      extra: {
        requirements: {
          assignmentStrategy: { variant: AssignmentStrategyVariant.Single },
          slots: 1,
          reward: 1000000000,
          minReputation: 0,
        },
      },
    };

    const jobRegistration = convertConfigToJob(config);

    expect(jobRegistration).toEqual(expectedJobRegistration);
  });

  test("should throw an error for invalid execution type", () => {
    const config: AcurastProjectConfig = {
      fileUrl: "./script.js",
      execution: {
        type: "invalid",
      } as any,
      usageLimit: {
        maxMemory: 0,
        maxNetworkRequests: 0,
        maxStorage: 0,
      },
    } as any;

    expect(() => convertConfigToJob(config)).toThrow("Invalid execution type");
  });
});
