/**
 * Copyright 2004-present Facebook. All Rights Reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

import streamify from 'stream-array';
import {JSONPath} from 'jsonpath-plus';

import type {
  GroupLoadingStrategy,
  RoleLoadingStrategy,
  ProxyRequest,
  Task,
  Workflow,
} from '../types';

// Global prefix for taskdefs which can be used by all tenants.
export const GLOBAL_PREFIX: string = 'GLOBAL';

// This is used to separate tenant id from name in workflowdefs and taskdefs
export const INFIX_SEPARATOR: string = '___';

const SUB_WORKFLOW: string = 'SUB_WORKFLOW';
const DECISION: string = 'DECISION';
const FORK: string = 'FORK';
const SYSTEM_TASK_TYPES: Array<string> = [
  SUB_WORKFLOW,
  DECISION,
  'EVENT',
  'HTTP',
  FORK,
  'FORK_JOIN',
  'FORK_JOIN_DYNAMIC',
  'JOIN',
  'EXCLUSIVE_JOIN',
  'WAIT',
  'DYNAMIC',
  'LAMBDA',
  'TERMINATE',
  'KAFKA_PUBLISH',
  'DO_WHILE',
];

const WHITELISTED_SIMPLE_TASKS = ['GLOBAL___js', 'GLOBAL___py', 'GLOBAL___HTTP_task'];

export function isLabeledWithGroup(
  workflowdef: Workflow,
  groups: string[],
): boolean {
  const lowercaseGroups = groups.map(g => g.toLowerCase());
  return getWorkflowLabels(workflowdef).some(
    l => lowercaseGroups.indexOf(l.toLowerCase()) >= 0,
  );
}

export function getWorkflowLabels(workflowdef: Workflow): string[] {
  const descr = workflowdef.description;
  if (descr && descr.match(/-(,|) [A-Z].*/g)) {
    return descr
      .substring(descr.indexOf('-') + 1)
      .replace(/\s/g, '')
      .split(',');
  }

  return [];
}

function isAllowedSystemTask(task: Task): boolean {
  return SYSTEM_TASK_TYPES.includes(task.type);
}

export function isSubworkflowTask(task: Task): boolean {
  return SUB_WORKFLOW === task.type;
}

export function isDecisionTask(task: Task): boolean {
  return DECISION === task.type;
}

export function isForkTask(task: Task): boolean {
  return FORK === task.type;
}

function isWhitelistedSimpleTask(task: Task): boolean {
  return task.type == 'SIMPLE' && WHITELISTED_SIMPLE_TASKS.includes(task.name);
}

// TODO: remove 'System' from name
export function assertAllowedSystemTask(task: Task): void {
  if (!isAllowedSystemTask(task) && !isWhitelistedSimpleTask(task)) {
    console.error(
      `Task type is not allowed: ` + ` in '${JSON.stringify(task)}'`,
    );
    // TODO create Exception class
    throw 'Task type is not allowed';
  }

  // assert decisions recursively
  if (isDecisionTask(task)) {
    const defaultCaseTasks = task.defaultCase ? task.defaultCase : [];
    for (const task of defaultCaseTasks) {
      assertAllowedSystemTask(task);
    }

    const decisionCaseIdToTasks: {[string]: Array<Task>} = task.decisionCases
      ? task.decisionCases
      : {};
    const values: Array<Array<Task>> = objectToValues(decisionCaseIdToTasks);
    for (const tasks of values) {
      for (const task of tasks) {
        assertAllowedSystemTask(task);
      }
    }
  }
}

// TODO: necessary because of https://github.com/facebook/flow/issues/2221
export function objectToValues<A, B>(obj: {[key: A]: B}): Array<B> {
  // eslint-disable-next-line flowtype/no-weak-types
  return ((Object.values(obj): Array<any>): Array<B>);
}

export function withInfixSeparator(s: string): string {
  return s + INFIX_SEPARATOR;
}

export function addTenantIdPrefix(
  tenantId: string,
  objectWithName: {name: string},
  allowGlobal: boolean = false,
): void {
  if (
    allowGlobal &&
    objectWithName.name.indexOf(withInfixSeparator(GLOBAL_PREFIX)) == 0
  ) {
    return;
  }
  assertNameIsWithoutInfixSeparator(objectWithName);
  objectWithName.name = withInfixSeparator(tenantId) + objectWithName.name;
}

export function assertNameIsWithoutInfixSeparator(objectWithName: {
  name: string,
}): void {
  assertValueIsWithoutInfixSeparator(objectWithName.name);
}

export function assertValueIsWithoutInfixSeparator(value: string): void {
  if (value.indexOf(INFIX_SEPARATOR) > -1) {
    console.error(`Value must not contain '${INFIX_SEPARATOR}' in '${value}'`);
    // TODO create Exception class
    throw 'Value must not contain INFIX_SEPARATOR';
  }
}

export function getTenantId(req: ExpressRequest): string {
  const tenantId: ?string = req.headers['x-tenant-id'];
  if (tenantId == null) {
    console.error('x-tenant-id header not found');
    throw 'x-tenant-id header not found';
  }
  if (tenantId == GLOBAL_PREFIX) {
    console.error(`Illegal name for TenantId: '${tenantId}'`);
    throw 'Illegal TenantId';
  }
  return tenantId;
}

export function getUserEmail(req: ExpressRequest): string {
  const userEmail: ?string = req.headers['from'];
  if (userEmail == null) {
    console.error('"from" header not found');
    throw '"from" header not found';
  }
  return userEmail;
}

export function getUserRole(
  req: ExpressRequest,
  roleLoadingStrategy: RoleLoadingStrategy,
): Promise<string> {
  return roleLoadingStrategy(
    getTenantId(req),
    getUserEmail(req),
  );
}

export async function getUserGroups(
  req: ExpressRequest,
  role: string,
  groupLoadingStrategy: GroupLoadingStrategy,
): Promise<string[]> {
  return groupLoadingStrategy(
    getTenantId(req),
    getUserEmail(req),
    role,
  );
}

export function createProxyOptionsBuffer(
  modifiedBody: mixed,
  req: ProxyRequest,
): mixed {
  // if request transformer returned modified body,
  // serialize it to new request stream. Original
  // request stream was already consumed. See `buffer` option
  // in node-http-proxy.
  if (typeof modifiedBody === 'object') {
    modifiedBody = JSON.stringify(modifiedBody);
  }
  if (typeof modifiedBody === 'string') {
    req.headers['content-length'] = modifiedBody.length;
    // create an array
    modifiedBody = [modifiedBody];
  } else {
    console.error('Unknown type', {modifiedBody});
    throw 'Unknown type';
  }
  return streamify(modifiedBody);
}

// Mass remove tenant prefix from json object.
// Setting allowGlobal to true implies that tasks are being processed,
// those starting with global prefix will not be touched.
export function removeTenantPrefix(
  tenantId: string,
  json: mixed,
  jsonPath: string,
  allowGlobal: boolean,
): void {
  const tenantWithInfixSeparator = withInfixSeparator(tenantId);
  const globalPrefix = withInfixSeparator(GLOBAL_PREFIX);
  const result = findValuesByJsonPath(json, jsonPath);
  for (const idx in result) {
    const item = result[idx];
    const prop = item.parent[item.parentProperty];
    if (allowGlobal && prop.indexOf(globalPrefix) == 0) {
      continue;
    }
    // expect tenantId prefix
    if (prop.indexOf(tenantWithInfixSeparator) != 0) {
      if (jsonPath.indexOf('taskDefName') != -1) {
        // Skipping tenant removal in taskDefName
        //  This is expected as some tasks do not require task def
        //  and might contain just some default
        continue;
      }

      console.error(
        `Name must start with tenantId prefix` +
          `tenantId:'${tenantId}',jsonPath:'${jsonPath}'` +
          `,item:'${item}'`,
        {json},
      );
      throw 'Name must start with tenantId prefix'; // TODO create Exception class
    }
    // remove prefix
    item.parent[item.parentProperty] = prop.substr(
      tenantWithInfixSeparator.length,
    );
  }
}

// See removeTenantPrefix
export function removeTenantPrefixes(
  tenantId: string,
  json: mixed,
  jsonPathToAllowGlobal: {[string]: boolean},
): void {
  for (const key in jsonPathToAllowGlobal) {
    removeTenantPrefix(tenantId, json, key, jsonPathToAllowGlobal[key]);
  }
}

export function findValuesByJsonPath(
  json: mixed,
  path: string,
  resultType: string = 'all',
) {
  const result = JSONPath({json, path, resultType});
  console.info(`For path '${path}' found ${result.length} items`);
  return result;
}

// TODO: delete this once the proxy is 100% typed
// eslint-disable-next-line flowtype/no-weak-types
export function anythingTo<T>(anything: any): T {
  if (anything != null) {
    return (anything: T);
  } else {
    throw 'Unexpected: value does not exist';
  }
}