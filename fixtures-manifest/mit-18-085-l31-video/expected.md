# MIT 18.085 Lecture 31 Video Expected / Rubric

## Scenario

Classroom video lecture: MIT 18.085 Lecture 31 from OpenCourseWare / Internet Archive, including the MP4 video, public SRT subtitles, and derivative keyframe thumbnails.

## Must Mention

- The source is a lecture video, not only a static image.
- The answer should combine transcript/audio evidence with keyframe or visual evidence.
- The lecture topic includes convolution, Fourier coefficients or transforms, signal processing / filtering, and FFT-style computation.
- The video evidence should expose at least one linked keyframe or original video artifact.

## Nice To Mention

- Professor Gilbert Strang is the lecturer if the answer chooses to mention the speaker.
- The keyframes show a classroom board / board work context.
- The user can follow up from a keyframe back to the linked video segment.

## Must Not Invent

- Do not invent homework deadlines, exam dates, student names, or private user attendance.
- Do not answer only from the image frame while ignoring subtitles/transcript.
- Do not treat the video as an office meeting or interview.
- Do not claim native model video understanding was used when the fixture is replaying keyframes plus public SRT.

## Acceptance Questions

```text
这段视频里老师讲了什么重点？
刚才视频和音频合起来说明了什么？
有哪些概念需要复习？
能不能给我看一下对应的视频证据？
```

## Pass Criteria

- `hostModelVideoMode` is `keyframes` or `direct`.
- `videoEventsWithArtifacts >= 1`.
- `keyframeEvents >= 1`.
- `videoRequestGroups >= 1`.
- Evidence contains transcript-ready audio tied to the same fixture / video request.
- The answer contains at least three of: convolution, Fourier, signal processing, filtering, FFT, cyclic convolution, polynomial multiplication.
