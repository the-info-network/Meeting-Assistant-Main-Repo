"use strict";

import { Sequelize } from "sequelize";

export const up = async ({ context: { queryInterface } }) => {
  await queryInterface.addColumn("meeting_super_agent_analyses", "processingStage", {
    type: Sequelize.STRING(64),
    allowNull: true,
  });
  await queryInterface.addColumn("meeting_super_agent_analyses", "assemblyTranscriptStatus", {
    type: Sequelize.STRING(32),
    allowNull: true,
  });
};

export const down = async ({ context: { queryInterface } }) => {
  await queryInterface.removeColumn("meeting_super_agent_analyses", "assemblyTranscriptStatus");
  await queryInterface.removeColumn("meeting_super_agent_analyses", "processingStage");
};
