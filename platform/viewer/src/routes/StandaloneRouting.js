import React, { Component } from 'react';
import OHIF from '@ohif/core';
import PropTypes from 'prop-types';
import qs from 'querystring';

import { extensionManager } from './../App.js';
import ConnectedViewer from '../connectedComponents/ConnectedViewer';
import ConnectedViewerRetrieveStudyData from '../connectedComponents/ConnectedViewerRetrieveStudyData';
import NotFound from '../routes/NotFound';

const { log, metadata, utils } = OHIF;
const { studyMetadataManager } = utils;
const { OHIFStudyMetadata } = metadata;

class StandaloneRouting extends Component {
  state = {
    studies: null,
    server: null,
    studyInstanceUIDs: null,
    seriesInstanceUIDs: null,
    error: null,
    loading: true,
  };

  static propTypes = {
    location: PropTypes.object,
    store: PropTypes.object,
    setServers: PropTypes.func,
  };

  // 格式化数据
  formatJson(data) {
    const {
      studies: {
        studyInstanceUid,
        patientName,
        studyDate,
        patientId,
        seriesList,
        patientAge,
        patientSex,
        institution,
      },
    } = data;
    let seriesArr = [];
    seriesList.forEach(series => {
      let instancesArr = [];
      seriesArr.push({
        SeriesDescription: series.seriesDescription,
        SeriesInstanceUID: series.seriesInstanceUid,
        SeriesNumber: series.seriesNumber,
        SeriesDate: '20010108',
        SeriesTime: '120318',
        Modality: series.modality,
        instances: instancesArr,
      });
      series.instances.forEach(instance => {
        instancesArr.push({
          metadata: {
            patientModule: {
              patientId: patientId,
              patientName: patientName,
              patientAge: patientAge,
              patientSex: patientSex,
            },
            generalStudyModule: {
              studyDescription: institution,
              studyDate: studyDate,
            },
            generalSeriesModule: {
              seriesDescription: series.seriesDescription,
              seriesNumber: series.seriesNumber,
            },
            generalImageModule: {
              instanceNumber: instance.instanceNumber ? instance.instanceNumber : '#',
            },
            Columns: instance.columns,
            Rows: instance.rows,
            InstanceNumber: instance.instanceNumber,
            AcquisitionNumber: 0,
            PhotometricInterpretation: 'MONOCHROME2',
            BitsAllocated: 16,
            BitsStored: 16,
            PixelRepresentation: 1,
            SamplesPerPixel: 1,
            Modality: series.modality,
            SOPInstanceUID: instance.sopInstanceUid,
            SeriesInstanceUID: series.seriesInstanceUid,
            StudyInstanceUID: studyInstanceUid,
          },
          url: instance.url,
        });
      });
    });

    return {
      studies: [
        {
          StudyInstanceUID: studyInstanceUid,
          StudyDescription: '影像描述',
          StudyDate: studyDate,
          StudyTime: '120022',
          PatientName: patientName,
          PatientId: patientId,
          series: seriesArr,
        },
      ],
    };
  }

  parseQueryAndRetrieveDICOMWebData(query) {
    return new Promise((resolve, reject) => {
      const { exam_uid, study_id } = query;
      const url = `${query.url}&exam_uid=${exam_uid}&study_id=${study_id}`;

      if (!url) {
        return reject(new Error('No URL was specified. Use ?url=$yourURL'));
      }

      // Define a request to the server to retrieve the study data
      // as JSON, given a URL that was in the Route
      const oReq = new XMLHttpRequest();

      // Add event listeners for request failure
      oReq.addEventListener('error', error => {
        log.warn('An error occurred while retrieving the JSON data');
        reject(error);
      });

      // When the JSON has been returned, parse it into a JavaScript Object
      // and render the OHIF Viewer with this data
      oReq.addEventListener('load', event => {
        if (event.target.status === 404) {
          reject(new Error('No JSON data found'));
        }

        // Parse the response content
        // https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/responseText
        if (!oReq.responseText) {
          log.warn('Response was undefined');
          reject(new Error('Response was undefined'));
        }

        log.info(JSON.stringify(oReq.responseText, null, 2));

        const data = JSON.parse(oReq.responseText);
        if (data.servers) {
          if (!query.studyInstanceUIDs) {
            log.warn('No study instance uids specified');
            reject(new Error('No study instance uids specified'));
          }

          const server = data.servers.dicomWeb[0];
          server.type = 'dicomWeb';

          log.warn('Activating server', server);
          this.props.activateServer(server);

          const studyInstanceUIDs = query.studyInstanceUIDs.split(';');
          const seriesInstanceUIDs = query.seriesInstanceUIDs
            ? query.seriesInstanceUIDs.split(';')
            : [];

          resolve({ server, studyInstanceUIDs, seriesInstanceUIDs });
        } else {
          // Parse data here and add to metadata provider.
          const metadataProvider = OHIF.cornerstone.metadataProvider;

          let StudyInstanceUID;
          let SeriesInstanceUID;

          // 在这里过滤数据
          const { data: res } = data;
          const result = this.formatJson(res);

          result.studies.forEach(study => {
            StudyInstanceUID = study.StudyInstanceUID;

            study.series.forEach(series => {
              SeriesInstanceUID = series.SeriesInstanceUID;

              series.instances.forEach(instance => {
                const { url: imageId, metadata: naturalizedDicom } = instance;

                // Add instance to metadata provider.
                metadataProvider.addInstance(naturalizedDicom);
                // Add imageId specific mapping to this data as the URL isn't necessarliy WADO-URI.
                metadataProvider.addImageIdToUIDs(imageId, {
                  StudyInstanceUID,
                  SeriesInstanceUID,
                  SOPInstanceUID: naturalizedDicom.SOPInstanceUID,
                });
              });
            });
          });

          resolve({ studies: result.studies, studyInstanceUIDs: [] });
        }
      });

      // Open the Request to the server for the JSON data
      // In this case we have a server-side route called /api/
      // which responds to GET requests with the study data
      log.info(`Sending Request to: ${url}`);
      oReq.open('GET', url);
      oReq.setRequestHeader('Accept', 'application/json');

      // Fire the request to the server
      oReq.send();
    });
  }

  async componentDidMount() {
    try {
      let { search } = this.props.location;

      // Remove ? prefix which is included for some reason
      search = search.slice(1, search.length);
      const query = qs.parse(search);

      let {
        server,
        studies,
        studyInstanceUIDs,
        seriesInstanceUIDs,
      } = await this.parseQueryAndRetrieveDICOMWebData(query);

      if (studies) {
        const {
          studies: updatedStudies,
          studyInstanceUIDs: updatedStudiesInstanceUIDs,
        } = _mapStudiesToNewFormat(studies);
        studies = updatedStudies;
        studyInstanceUIDs = updatedStudiesInstanceUIDs;
      }

      this.setState({
        studies,
        server,
        studyInstanceUIDs,
        seriesInstanceUIDs,
        loading: false,
      });
    } catch (error) {
      this.setState({ error: error.message, loading: false });
    }
  }

  render() {
    const message = this.state.error
      ? `Error: ${JSON.stringify(this.state.error)}`
      : 'Loading...';
    if (this.state.error || this.state.loading) {
      return <NotFound message={message} showGoBackButton={this.state.error} />;
    }

    return this.state.studies ? (
      <ConnectedViewer studies={this.state.studies} />
    ) : (
      <ConnectedViewerRetrieveStudyData
        studyInstanceUIDs={this.state.studyInstanceUIDs}
        seriesInstanceUIDs={this.state.seriesInstanceUIDs}
        server={this.state.server}
      />
    );
  }
}

const _mapStudiesToNewFormat = studies => {
  studyMetadataManager.purge();

  /* Map studies to new format, update metadata manager? */
  const uniqueStudyUIDs = new Set();
  const updatedStudies = studies.map(study => {
    const studyMetadata = new OHIFStudyMetadata(study, study.StudyInstanceUID);

    const sopClassHandlerModules =
      extensionManager.modules['sopClassHandlerModule'];
    study.displaySets =
      study.displaySets ||
      studyMetadata.createDisplaySets(sopClassHandlerModules);

    studyMetadataManager.add(studyMetadata);
    uniqueStudyUIDs.add(study.StudyInstanceUID);

    return study;
  });

  return {
    studies: updatedStudies,
    studyInstanceUIDs: Array.from(uniqueStudyUIDs),
  };
};

export default StandaloneRouting;
