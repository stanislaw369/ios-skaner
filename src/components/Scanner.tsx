import * as React from 'react';
import { Alert, Dimensions, Platform, SafeAreaView, StyleSheet, Switch, Text, View } from 'react-native';
import { Camera, FormatFilter, PhotoFile, Templates, runAtTargetFps, useCameraDevice, useCameraDevices, useCameraFormat, useFrameProcessor, useSkiaFrameProcessor } from 'react-native-vision-camera';
import * as DDN from "vision-camera-dynamsoft-document-normalizer";
import { Svg, Polygon } from 'react-native-svg';
import type { DetectedQuadResult } from 'vision-camera-dynamsoft-document-normalizer';
import { useEffect, useRef, useState } from 'react';
import { Worklets,useSharedValue } from 'react-native-worklets-core';
import { intersectionOverUnion, sleep, getRectFromPoints } from '../Utils';
import { defaultTemplate, whiteTemplate } from '../Templates';

export interface ScannerProps{
    onScanned?: (path:PhotoFile|null,isWhiteBackgroundEnabled:boolean,detectionResult:DetectedQuadResult,frameWidth:number,frameHeight:number) => void;
  }
  
export default function Scanner(props:ScannerProps) {
  const [isWhiteBackgroundEnabled, setIsWhiteBackgroundEnabled] = useState(false);
  const isWhiteBackgroundEnabledShared = useSharedValue(false);
  const toggleSwitch = () => {
    isWhiteBackgroundEnabledShared.value = (!isWhiteBackgroundEnabled);
    setIsWhiteBackgroundEnabled(previousState => !previousState)
  };
  const camera = useRef<Camera|null>(null)
  const [isActive,setIsActive] = useState(true);
  const [hasPermission, setHasPermission] = useState(false);
  const [detectionResults,setDetectionResults] = useState([] as DetectedQuadResult[]);
  const convertAndSetResults = (records:Record<string,DetectedQuadResult>) => {
    let results:DetectedQuadResult[] = [];
    for (let index = 0; index < Object.keys(records).length; index++) {
      const result = records[Object.keys(records)[index]];
      const rect = getRectFromPoints(result.location.points);
      if (rect.width / getFrameSize()[0].value < 0.95) { //avoid full screen misdetection
        results.push(result);
      }
    }
    setDetectionResults(results);
  }
  const convertAndSetResultsJS = Worklets.createRunOnJS(convertAndSetResults);
  const frameWidth = useSharedValue(1920);
  const frameHeight = useSharedValue(1080);
  const [viewBox,setViewBox] = useState("0 0 1080 1920");
  const [pointsText, setPointsText] = useState("default");
  const takenShared = useSharedValue(false);
  const [taken,setTaken] = useState(false);
  const photo = useRef<PhotoFile|null>(null);
  const previousResults = useRef([] as DetectedQuadResult[]);
  const device = useCameraDevice("back");
  const getFormatOptions = () => {
    let options:FormatFilter[] = [
      { videoResolution: { width: 1280, height: 720 } },
      {photoAspectRatio: 16/9 },
      {videoAspectRatio: 16/9 },
      { fps: 60 }
    ];
    if (Platform.OS != "android") {
      options.unshift({ photoResolution: 'max' });
    }
    console.log(options);
    return options;
  }
  const cameraFormat = useCameraFormat(device, getFormatOptions());
  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === 'granted');
    })();
  }, []);

  useEffect(() => {
    const updateSettings = async () => {
      if (isWhiteBackgroundEnabled) {
        console.log("use white template");
        await DDN.initRuntimeSettingsFromString(whiteTemplate);
      }else{
        await DDN.initRuntimeSettingsFromString(defaultTemplate);
      }
    }
    updateSettings();
  }, [isWhiteBackgroundEnabled]);

  useEffect(() => {
    updateViewBox();
    updatePointsData();
  }, [detectionResults]);

  const getFrameSize = () => {
    let width, height;
    if (frameWidth>frameHeight && Dimensions.get('window').width>Dimensions.get('window').height){
      width = frameWidth;
      height = frameHeight;
    }else {
      console.log("Has rotation");
      width = frameHeight;
      height = frameWidth;
    }
    return [width, height];
  }

  const updateViewBox = () => {
    const frameSize = getFrameSize();
    setViewBox("0 0 "+frameSize[0]+" "+frameSize[1]);
    console.log("viewBox"+viewBox);
  }

  const updatePointsData = () => {
    if (detectionResults.length>0) {
      let result = detectionResults[0];
      if (result) {
        let location = result.location;
        let pointsData = location.points[0].x + "," + location.points[0].y + " ";
        pointsData = pointsData + location.points[1].x + "," + location.points[1].y +" ";
        pointsData = pointsData + location.points[2].x + "," + location.points[2].y +" ";
        pointsData = pointsData + location.points[3].x + "," + location.points[3].y;
        setPointsText(pointsData);
      }
    }else{
      setPointsText("default");
    }
  }
  
  useEffect(() => {
    if (pointsText != "default") {
      console.log("pointsText changed");
      checkIfSteady();
    }
  }, [pointsText]);


  const takePhoto = async () => {
    console.log("take photo");
    if (camera.current) {
      console.log("using camera");
      setTaken(true);
      takenShared.value = true;
      await sleep(100);
      photo.current = await camera.current.takePhoto();
      if (photo.current) {
        console.log(photo.current);
        setIsActive(false);
        if (Platform.OS === "android") {
          if (photo.current.metadata && photo.current.metadata.Orientation === 6) {
            console.log("rotate bitmap for Android");
            await DDN.rotateFile(photo.current.path,90);
          }
        }
        if (props.onScanned) {
          console.log(photo.current);
          props.onScanned(
            photo.current,
            isWhiteBackgroundEnabled,
            detectionResults[0],
            getFrameSize()[0].value,
            getFrameSize()[1].value
          );
        }
      }else{
        Alert.alert("","Failed to take a photo");
        setTaken(false);
        takenShared.value = false;
      }
    }
  }

  const checkIfSteady = async () => {
    if (detectionResults.length == 0) {
      return;
    }
    let result = detectionResults[0];
    console.log("previousResults");
    console.log(previousResults);
    if (result) {
      if (previousResults.current.length >= 2) {
        previousResults.current.push(result);
        if (steady() == true) {
          await takePhoto();
          console.log("steady");
        }else{
          console.log("shift result");
          previousResults.current.shift();
        }
      }else{
        console.log("add result");
        previousResults.current.push(result);
      }
    }
  }

  const steady = () => {
    if (previousResults.current[0] && previousResults.current[1] && previousResults.current[2]) {
      let iou1 = intersectionOverUnion(previousResults.current[0].location.points,previousResults.current[1].location.points);
      let iou2 = intersectionOverUnion(previousResults.current[1].location.points,previousResults.current[2].location.points);
      let iou3 = intersectionOverUnion(previousResults.current[0].location.points,previousResults.current[2].location.points);
      console.log(iou1);
      console.log(iou2);
      console.log(iou3);
      if (iou1>0.9 && iou2>0.9 && iou3>0.9) {
        return true;
      }else{
        return false;
      }
    }
    return false;
  }

  const frameProcessor = useSkiaFrameProcessor((frame) => {
    'worklet'
    console.log("detect frame");
    console.log(frame.width);
    console.log(frame.height);
    frame.render();
    if (takenShared.value === false) {
      runAtTargetFps(3, () => {
        'worklet'
        try {
          const results = DDN.detect(frame);
          console.log(results);
          frameWidth.value = frame.width;
          frameHeight.value = frame.height;
          convertAndSetResultsJS(results);
        } catch (error) {
          console.log(error);
        }
      })
    }
  }, [])

  return (
      <SafeAreaView style={styles.container}>
        {device != null &&
        hasPermission && (
        <>
            <Camera
              style={StyleSheet.absoluteFill}
              ref={camera}
              isActive={isActive}
              device={device}
              photo={true}
              format={cameraFormat}
              frameProcessor={frameProcessor}
              pixelFormat='yuv'
            />
            <Svg preserveAspectRatio='xMidYMid slice' style={StyleSheet.absoluteFill} viewBox={viewBox}>
              {pointsText != "default" && (
                <Polygon
                  points={pointsText}
                  fill="lime"
                  stroke="green"
                  opacity="0.5"
                  strokeWidth="1"
                />
              )}
            </Svg>
            <View style={styles.control}>
              <Text>Enable White Background Template:</Text>
              <Switch
                trackColor={{false: '#767577', true: '#81b0ff'}}
                thumbColor={isWhiteBackgroundEnabled ? '#f5dd4b' : '#f4f3f4'}
                ios_backgroundColor="#3e3e3e"
                onValueChange={toggleSwitch}
                value={isWhiteBackgroundEnabled}
              />
            </View>
        </>)}
      </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  control:{
    flexDirection:"row",
    position: 'absolute',
    bottom: 0,
    height: 100,
    width:"100%",
    alignSelf:"flex-start",
    alignItems: 'center',
    backgroundColor:'rgba(255, 255, 255, 0.5)',
  },
});
