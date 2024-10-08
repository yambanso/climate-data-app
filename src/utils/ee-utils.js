import i18n from "@dhis2/d2-i18n";
import area from "@turf/area";
import { HOURLY, getMappedPeriods } from "./time";

const VALUE_LIMIT = 5000;

// Returns the linear scale in meters of the units of this projection
export const getScale = (image) => image.select(0).projection().nominalScale();

// Makes evaluate a promise
export const getInfo = (instance) =>
  new Promise((resolve, reject) =>
    instance.evaluate((data, error) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    })
  );

// Reduce a feature collection to array of objects with id and properties
export const getFeatureCollectionPropertiesArray = (data) =>
  data.features.map((f) => ({
    id: f.id,
    ...f.properties,
  }));

export const cleanData = (data) =>
  data.map((f) => ({
    id: f.id.substring(9),
    date: f.id.slice(0, 8),
    value: f.properties.value,
  }));

export const getEarthEngineValues = (ee, datasetParams, period, features) =>
  new Promise(async (resolve, reject) => {
    const dataset = period.timeZone
      ? { ...datasetParams, ...datasetParams.timeZone }
      : datasetParams;

    const {
      datasetId,
      band,
      reducer = "mean",
      periodType,
      periodReducer = reducer,
      valueParser,
    } = dataset;

    const { startTime, endTime, timeZone = "UTC", calendar } = period;
    const endTimePlusOne = ee.Date(endTime).advance(1, "day");
    const timeZoneStart = ee.Date(startTime).format(null, timeZone);
    const timeZoneEnd = endTimePlusOne.format(null, timeZone);
    const mappedPeriods = getMappedPeriods(period);

    // periods?.reduce((map, p) => {
    //   map.set(toIso(p.startTime, calendar), p.iso);
    //   return map;
    // }, mappedPeriods);

    const dataParser = (data) =>
      data.map((f) => ({
        ...f.properties,
        period: mappedPeriods.get(f.properties.period),
        value: valueParser
          ? valueParser(f.properties.value)
          : f.properties.value,
      }));

    const collection = ee
      .ImageCollection(datasetId)
      .select(band)
      .filter(ee.Filter.date(timeZoneStart, timeZoneEnd));

    const imageCount = await getInfo(collection.size());

    if (imageCount === 0) {
      return reject(new Error(i18n.t("No data found for the selected period")));
    }

    let eeScale = getScale(collection.first());

    if (reducer === "min" || reducer === "max") {
      // ReduceRegions with min/max reducer may fail if the features are smaller than the pixel area
      // https://stackoverflow.com/questions/59774022/reduce-regions-some-features-dont-contains-centroid-of-pixel-in-consecuence-ex

      const scale = await getInfo(eeScale);

      const minArea = Math.min(
        ...features.filter((f) => f.geometry.type.includes("Polygon")).map(area)
      );

      if (minArea < scale * scale) {
        eeScale = Math.sqrt(minArea) / 2;
      }
    }

    const featureCollection = ee.FeatureCollection(features);

    const eeReducer = ee.Reducer[reducer]();

    let dailyCollection;

    if (periodType === HOURLY) {
      const days = ee
        .Date(timeZoneEnd)
        .difference(ee.Date(timeZoneStart), "days");

      const daysList = ee.List.sequence(0, days.subtract(1));

      dailyCollection = ee.ImageCollection.fromImages(
        daysList.map((day) => {
          const startUTC = ee.Date(startTime).advance(day, "days");
          const start = ee.Date(startUTC.format(null, timeZone));
          const end = start.advance(1, "days");
          const filtered = collection.filter(ee.Filter.date(start, end));

          return filtered[periodReducer]()
            .set("system:index", startUTC.format("YYYYMMdd"))
            .set("system:time_start", start.millis())
            .set("system:time_end", end.millis());
        })
      ).filter(ee.Filter.listContains("system:band_names", band)); // Remove empty images
    }

    const reduced = (dailyCollection || collection)
      .map((image) =>
        image
          .reduceRegions({
            collection: featureCollection,
            reducer: eeReducer,
            scale: eeScale,
          })
          .map((feature) =>
            ee.Feature(null, {
              ou: feature.get("id"),
              period: image.date().format("YYYY-MM-dd"),
              value: feature.get(reducer),
            })
          )
      )
      .flatten();

    const valueCollection = ee.FeatureCollection(reduced);

    const valueCount = await getInfo(valueCollection.size());

    if (valueCount <= VALUE_LIMIT) {
      getInfo(valueCollection.toList(VALUE_LIMIT))
        .then(dataParser)
        .then(resolve);
    } else {
      const chunks = Math.ceil(valueCount / VALUE_LIMIT);

      Promise.all(
        Array.from({ length: chunks }, (_, chunk) =>
          getInfo(valueCollection.toList(VALUE_LIMIT, chunk * VALUE_LIMIT))
        )
      )
        .then((data) => [].concat(...data))
        .then(dataParser)
        .then(resolve);
    }
  });

export const getEarthEngineData = (ee, datasetParams, period, features) => {
  if (datasetParams.bands) {
    // Multiple bands (used for relative humidity)
    const { bandsParser = (v) => v } = datasetParams;

    return Promise.all(
      datasetParams.bands.map((band) =>
        getEarthEngineValues(
          ee,
          { ...datasetParams, ...band },
          period,
          features
        )
      )
    ).then(bandsParser);
  } else {
    return getEarthEngineValues(ee, datasetParams, period, features);
  }
};

export const getTimeSeriesData = async (ee, dataset, period, geometry) => {
  const { datasetId, band, reducer = "mean", sharedInputs = false } = dataset;

  let collection = ee.ImageCollection(datasetId).select(band);

  let eeReducer;

  if (Array.isArray(reducer)) {
    // Combine multiple reducers
    // sharedInputs = true means that all reducers are applied to all bands
    // sharedInouts = false means one reducer for each band
    eeReducer = reducer.reduce(
      (r, t, i) =>
        i === 0
          ? r[t]().unweighted()
          : r.combine({
              reducer2: ee.Reducer[t]().unweighted(),
              outputPrefix: sharedInputs ? "" : String(i),
              sharedInputs,
            }),
      ee.Reducer
    );

    if (!sharedInputs && Array.isArray(band)) {
      // Use band names as output names
      eeReducer = eeReducer.setOutputs(band);
    }
  } else {
    // Single reducer
    eeReducer = ee.Reducer[reducer]();
  }

  const { startTime, endTime, timeZone = "UTC" } = period;
  const endTimePlusOne = ee.Date(endTime).advance(1, "day");
  const timeZoneStart = ee.Date(startTime).format(null, timeZone);
  const timeZoneEnd = endTimePlusOne.format(null, timeZone);

  collection = collection.filter(ee.Filter.date(timeZoneStart, timeZoneEnd));

  let eeScale = getScale(collection.first());

  const { type, coordinates } = geometry;

  if (type.includes("Polygon")) {
    // unweighted reducer may fail if the features are smaller than the pixel area
    const scale = await getInfo(eeScale);
    const orgUnitArea = area(geometry);

    if (orgUnitArea < scale * scale) {
      eeScale = Math.sqrt(orgUnitArea) / 2;
    }
  }

  const eeGeometry = ee.Geometry[type](coordinates);

  // Returns a time series array of objects
  return getInfo(
    ee.FeatureCollection(
      collection.map((image) =>
        ee
          .Feature(null, image.reduceRegion(eeReducer, eeGeometry, eeScale))
          .set("system:index", image.get("system:index"))
      )
    )
  ).then(getFeatureCollectionPropertiesArray);
};
