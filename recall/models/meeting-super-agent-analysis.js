import { DataTypes } from "sequelize";

export default (sequelize) => {
  return sequelize.define(
    "MeetingSuperAgentAnalysis",
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
      },
      meetingArtifactId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: "queued",
      },
      requestedFeatures: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      assemblyTranscriptId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      /** App-defined phase: queued, transcription, analysis */
      processingStage: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      /** Last seen AssemblyAI transcript.status while waiting (queued, processing, completed, error) */
      assemblyTranscriptStatus: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      assemblyRequest: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      assemblyResult: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      detailedSummary: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      actionItems: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      decisions: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      highlights: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      chapters: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      sentiment: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      topics: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      contentSafety: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      piiRedactionApplied: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
      },
      translation: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      tableName: "meeting_super_agent_analyses",
      modelName: "MeetingSuperAgentAnalysis",
    }
  );
};
