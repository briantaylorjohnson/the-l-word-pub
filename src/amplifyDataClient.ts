import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource';
import outputs from '../amplify_outputs.json';

// Amplify.configure() must run before generateClient() is called anywhere
// in the app. ES module imports are evaluated before the importing
// module's own top-level code, so calling configure() in main.tsx doesn't
// reliably run first if something it imports (transitively) creates a
// client at module-eval time — centralizing both calls in this one file
// guarantees the order regardless of import graph.
Amplify.configure(outputs);

export const dataClient = generateClient<Schema>();
