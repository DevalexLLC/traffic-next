// Root entry: the wire contract only.
//
// Deliberately free of React and Next imports so it can be pulled into a test,
// a script, or a non-React consumer without dragging a renderer along.
export {
  TrafficEvent,
  TrafficType,
  trafficBatchSchema,
  trafficEventSchema,
  type TrafficBatch,
  type TrafficEventInput,
} from "./models.js";
