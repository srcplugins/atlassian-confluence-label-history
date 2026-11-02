import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { registerResolvers } from './resolvers';

export const handler = registerResolvers({ Resolver, api, route });
