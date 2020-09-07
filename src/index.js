/**
 * Copyright 2004-present Facebook. All Rights Reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */
'use strict';

import ExpressApplication from 'express';
import proxy from './proxy/proxy';
import workflowRouter from './routes';
import {getUserRole, getUserGroups} from './proxy/utils.js';
import {groupsForUser, rolesForUser} from './proxy/keycloakGroups';

import bulk from './proxy/transformers/bulk';
import event from './proxy/transformers/event';
import metadataTaskdef from './proxy/transformers/metadata-taskdef';
import metadataWorkflowdef from './proxy/transformers/metadata-workflowdef';
import schellar from './proxy/transformers/schellar';
import task from './proxy/transformers/task';
import workflow from './proxy/transformers/workflow';

import metadataWorkflowdefRbac from './proxy/transformers/metadata-workflowdef-rbac';
import workflowRbac from './proxy/transformers/workflow-rbac';
import taskProxy from './task-proxy';
import schellarProxy from './schellar-proxy';

import dotenv from "dotenv";

import type {$Application, ExpressRequest, ExpressResponse} from 'express';

dotenv.config();

const app = ExpressApplication();

// TODO make configurable
const OWNER_ROLE = 'OWNER';
const NETWORK_ADMIN_GROUP = 'network-admin';

const adminAccess = (roles, groups) => {
  return roles.includes(OWNER_ROLE) || groups.includes(NETWORK_ADMIN_GROUP);
};

const generalAccess = (_role, _groups) => {
  return true;
};

const schellarProxyPort = process.env.SCHELLAR_PROXY_PORT ?? 8087;
const userFacingPort = process.env.USER_FACING_PORT ?? 8088;
const taskProxyPort = process.env.TASK_PROXY_PORT ?? 8089;
const proxyTarget =
    process.env.PROXY_TARGET || 'http://conductor-server:8080';
const schellarTarget = process.env.SCHELLAR_TARGET || 'http://schellar:3000';

async function init() {
  const proxyRouter = await proxy(
    proxyTarget,
    schellarTarget,
    // TODO populate from fs
    [
      bulk,
      event,
      metadataTaskdef,
      metadataWorkflowdef,
      workflow,
      task,
      schellar,
    ],
    adminAccess,
    groupsForUser,
    rolesForUser,
  );

  app.use('/', await workflowRouter('http://localhost:8088/proxy/'));
  app.use('/proxy', proxyRouter);

  const rbacConductorRouter: $Application<
    ExpressRequest,
    ExpressResponse,
  > = await workflowRouter('http://localhost:8088/rbac_proxy/');
  // Expose a simple boolean endpoint to check if current user is privileged
  rbacConductorRouter.get(
    '/editableworkflows',
    async (req: ExpressRequest, res, _) => {
      const role = await getUserRole(req, rolesForUser);
      res
        .status(200)
        .send(
          adminAccess(
            role,
            await getUserGroups(req, role, groupsForUser),
          ),
        );
    },
  );

  const rbacRouter = await proxy(
    proxyTarget,
    'UNSUPPORTED', // Scheduling not allowed
    [
      metadataWorkflowdefRbac,
      workflowRbac,
      // FIXME override task and bulk and implement user group checks
      task,
      bulk,
    ],
    generalAccess,
    groupsForUser,
    rolesForUser
  );

  app.use('/rbac', rbacConductorRouter);
  app.use('/rbac_proxy', rbacRouter);
  app.get("/probe/liveness", (req, res) => res.sendStatus(200));
  app.get("/probe/readiness", (req, res) => res.sendStatus(200));
  app.listen(userFacingPort);
  taskProxy.init(proxyTarget, taskProxyPort);
  schellarProxy.init(proxyTarget, schellarProxyPort);
}

init();
