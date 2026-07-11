import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Plus, Loader2, CheckCircle2, XCircle, Cpu, Wrench, Info, HelpCircle } from "lucide-react";

interface Model {
  slot: number;
  name: string;
  model_id: string;
  deploy_id: string | null;
  deployed: boolean;
}

interface DeployProgress {
  deploy_id: string;
  slot: number;
  name: string;
  progress: number;
  stage: string;
  done: boolean;
  failed: boolean;
  errorMsg?: string;
}

const DEFAULT_CORES = 1;

type ModelType = "default" | "custom";

// Required field label
const Req = () => <span className="text-destructive ml-0.5">*</span>;

// Inline tooltip
const Tip = ({ text }: { text: string }) => {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex items-center ml-1">
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(v => !v)}
        className="text-muted-foreground hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {show && (
        <span className="absolute left-5 top-0 z-50 w-64 rounded-md border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-md leading-relaxed whitespace-pre-line">
          {text}
        </span>
      )}
    </span>
  );
};

const CUSTOM_MODEL_INFO = `Custom model requirements:

• Only YOLOv8 models are supported currently (.pt format)
• The model must be trained with Ultralytics YOLOv8
• Supported tasks: Object Detection only

Why a calibration dataset?
The AIPU runs in INT8 precision (8-bit integers) instead of FP32 (32-bit floating point). This makes it ~4× faster with much less memory, but requires a calibration step to figure out the best way to quantize your weights.

The dataset you provide is used ONLY for calibration — not retraining. ~100–500 representative images is enough.`;

const CORES_INFO = `AIPU Cores — how many AI processor cores to allocate for this model.

The Axelera M2 has a limited number of cores:
• 1 core = standard speed, allows more models simultaneously
• 2 cores = faster inference for this model, fewer slots available

With 1 core each, you can run up to 2 models at the same time on the M2.
Recommended: keep at 1 unless you only need this single model.`;

const DATA_YAML_INFO = `Your dataset zip must contain a data.yaml file with at least:

  nc: 2          # number of classes
  names:
    0: fire
    1: smoke

  train: train/images   # path to training images
  val: valid/images     # path to validation images
  test: test/images     # path to test images (optional)

The nc field is required — it tells the model how many classes to detect. The names field labels each class ID.

Folder structure inside zip:
  data.yaml
  train/images/*.jpg
  valid/images/*.jpg
  test/images/*.jpg   (optional)`;

const COCO_INFO = `YOLOv8n is a lightweight object detection model pretrained on the COCO dataset.

• Architecture: YOLOv8 Nano (fastest, lowest memory)
• Dataset: COCO 2017 — 80 everyday object classes
• Input: 640×640 RGB
• Compiled for Axelera M2 AIPU (1 core by default)

Use class IDs to filter which objects to detect. Leave empty to detect all 80 classes. Common use cases:
  • Security: 0 (person), 2 (car), 7 (truck)
  • Retail: 0 (person), 39 (bottle), 41 (cup)
  • Safety: 0 (person) only`;

const generateDefaultYaml = (
  modelName: string,
  description: string,
  cores: number,
  classIds: number[],
): string => {
  const name = modelName.trim().toLowerCase().replace(/\s+/g, "_") || "model";
  const desc = description.trim() || "";
  const labelFilterLine = classIds.length > 0
    ? "            label_filter: [" + classIds.join(", ") + "]\n"
    : "";

  return `axelera-model-format: 1.0.0

name: ${name}
description: ${desc}

pipeline:
  - detections:
      model_name: ${name}
      input:
        type: image
      preprocess:
        - letterbox:
            height: \${{input_height}}
            scaleup: true
            width: \${{input_width}}
        - torch-totensor:
      inference:
        handle_all: false
      postprocess:
        - decodeyolo:
            box_format: xywh
            conf_threshold: 0.25
` + labelFilterLine + `            max_nms_boxes: 30000
            nms_class_agnostic: true
            nms_iou_threshold: 0.45
            nms_top_k: 300
            normalized_coord: false
            use_multi_label: false
            eval:
              conf_threshold: 0.001
              nms_class_agnostic: false
              nms_iou_threshold: 0.7
              use_multi_label: true

models:
  ${name}:
    class: AxUltralyticsYOLO
    class_path: $AXELERA_FRAMEWORK/ax_models/yolo/ax_ultralytics.py
    weight_path: weights/yolov8n.pt
    weight_url: https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt
    task_category: ObjectDetection
    input_tensor_layout: NCHW
    input_tensor_shape: [1, 3, 640, 640]
    input_color_format: RGB
    num_classes: 80
    dataset: CocoDataset-COCO2017
    extra_kwargs:
      aipu_cores: ${cores}

datasets:
  CocoDataset-COCO2017:
    class: ObjDataAdapter
    class_path: $AXELERA_FRAMEWORK/ax_datasets/objdataadapter.py
    data_dir_name: coco
    labels_path: $AXELERA_FRAMEWORK/ax_datasets/labels/coco.names
    label_type: COCO2017

model-env:
  dependencies: [ultralytics]

operators:
  decodeyolo:
    class: DecodeYolo
    class_path: $AXELERA_FRAMEWORK/ax_models/decoders/yolo.py
`;
};

const generateCustomYaml = (
  modelName: string,
  description: string,
  cores: number,
  datasetName: string,
  numClasses: number,
): string => {
  const name = modelName.trim().toLowerCase().replace(/\s+/g, "_") || "model";
  const desc = description.trim() || "";
  const dsName = datasetName.trim().toLowerCase().replace(/\s+/g, "_");

  return `axelera-model-format: 1.0.0
name: ${name}
description: ${desc}

model-env:
  dependencies:
    - ultralytics

pipeline:
  - ${name}:
      template_path: $AXELERA_FRAMEWORK/pipeline-template/yolo-letterbox.yaml
      postprocess:
        - decodeyolo:
            max_nms_boxes: 30000
            conf_threshold: 0.05
            nms_iou_threshold: 0.45
            nms_class_agnostic: False
            nms_top_k: 300
            eval:
              conf_threshold: 0.01

models:
  ${name}:
    class: AxUltralyticsYOLO
    class_path: $AXELERA_FRAMEWORK/ax_models/yolo/ax_ultralytics.py
    weight_path: /home/voyager-sdk/customers/${name}/models/${name}.pt
    task_category: ObjectDetection
    input_tensor_layout: NCHW
    input_tensor_shape: [1, 3, 640, 640]
    input_color_format: RGB
    num_classes: ${numClasses}
    dataset: ${dsName}
    extra_kwargs:
      aipu_cores: ${cores}

datasets:
  ${dsName}:
    class: ObjDataAdapter
    class_path: $AXELERA_FRAMEWORK/ax_datasets/objdataadapter.py
    data_dir_name: ${dsName}
    label_type: YOLOv8
    labels: data.yaml
    cal_data: train
    val_data: test
`;
};

// ── Default Model Form ─────────────────────────────────────────────────────

const DefaultModelForm = ({
  onDeploy,
  onCancel,
  loading,
}: {
  onDeploy: (yaml: string, modelName: string, description: string, cores: number) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}) => {
  const { toast } = useToast();
  const [form, setForm] = useState({
    modelName: "",
    description: "",
    numberOfCores: String(DEFAULT_CORES),
    classIds: "0",
  });

  const handleDeploy = async () => {
    if (!form.modelName.trim()) {
      toast({ variant: "destructive", title: "Model name required" });
      return;
    }
    const classIds = form.classIds
      .split(",")
      .map(v => parseInt(v.trim(), 10))
      .filter(v => !isNaN(v));
    const cores = parseInt(form.numberOfCores, 10) || 1;
    const yaml = generateDefaultYaml(form.modelName, form.description, cores, classIds);
    await onDeploy(yaml, form.modelName, form.description, cores);
  };

  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Default Model (YOLOv8n + COCO)</h3>
        <button
          type="button"
          onClick={() => setShowInfo(v => !v)}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          {showInfo ? "Hide info" : "What is this model?"}
        </button>
      </div>
      {showInfo && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
          {COCO_INFO}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 items-start">
        <div className="space-y-1">
          <Label className="flex items-center gap-1">
            Model name<Req />
          </Label>

          <Input
            value={form.modelName}
            onChange={(e) =>
              setForm((f) => ({ ...f, modelName: e.target.value }))
            }
            placeholder="e.g. ppe_detection"
          />
        </div>

        <div className="space-y-1">
          <Label className="flex items-center gap-1">
            Cores<Req />
            <Tip text={CORES_INFO} />
          </Label>

          <Input
            type="number"
            min={1}
            max={4}
            value={form.numberOfCores}
            onChange={(e) =>
              setForm((f) => ({ ...f, numberOfCores: e.target.value }))
            }
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label>COCO class IDs</Label>
        <Input
          value={form.classIds}
          onChange={e => setForm(f => ({ ...f, classIds: e.target.value }))}
          placeholder="e.g. 0,1,2"
        />
        <div className="flex items-center gap-3 mt-1 flex-wrap">
         <p className="text-xs text-muted-foreground flex-1">
              Comma-separated IDs.{" "}
              
              <span className="inline-flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, classIds: "" }))}
                  className="underline hover:text-foreground"
                >
                  Clear to detect all 80 classes
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setForm(f => ({
                      ...f,
                      classIds:
                        "0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79"
                    }))
                  }
                  className="text-xs underline hover:text-foreground text-muted-foreground"
                >
                  Enable all 80
                </button>
              </span>
            </p>
          
          {form.classIds === "" && (
            <span className="text-xs text-green-600 font-medium">All classes ✓</span>
          )}
        </div>
        <details className="mt-1">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground select-none">
            Show all 80 COCO class IDs ▾
          </summary>
          <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs leading-5 text-muted-foreground font-mono max-h-48 overflow-y-auto">
            {[
              "0=person","1=bicycle","2=car","3=motorcycle","4=airplane",
              "5=bus","6=train","7=truck","8=boat","9=traffic light",
              "10=fire hydrant","11=stop sign","12=parking meter","13=bench",
              "14=bird","15=cat","16=dog","17=horse","18=sheep","19=cow",
              "20=elephant","21=bear","22=zebra","23=giraffe","24=backpack",
              "25=umbrella","26=handbag","27=tie","28=suitcase","29=frisbee",
              "30=skis","31=snowboard","32=sports ball","33=kite","34=baseball bat",
              "35=baseball glove","36=skateboard","37=surfboard","38=tennis racket",
              "39=bottle","40=wine glass","41=cup","42=fork","43=knife","44=spoon",
              "45=bowl","46=banana","47=apple","48=sandwich","49=orange",
              "50=broccoli","51=carrot","52=hot dog","53=pizza","54=donut",
              "55=cake","56=chair","57=couch","58=potted plant","59=bed",
              "60=dining table","61=toilet","62=tv","63=laptop","64=mouse",
              "65=remote","66=keyboard","67=cell phone","68=microwave","69=oven",
              "70=toaster","71=sink","72=refrigerator","73=book","74=clock",
              "75=vase","76=scissors","77=teddy bear","78=hair drier","79=toothbrush",
            ].map(entry => {
              const [id, label] = entry.split("=");
              const ids = form.classIds.split(",").map(v => v.trim());
              const active = ids.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    const current = form.classIds.split(",").map(v => v.trim()).filter(Boolean);
                    const updated = active
                      ? current.filter(v => v !== id)
                      : [...current, id];
                    setForm(f => ({ ...f, classIds: updated.join(", ") }));
                  }}
                  className={`inline-flex items-center gap-1 mr-1 mb-1 px-1.5 py-0.5 rounded border transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:border-primary hover:text-foreground"
                  }`}
                >
                  <span className="font-bold">{id}</span>
                  <span className="opacity-70">{label}</span>
                </button>
              );
            })}
          </div>
        </details>
      </div>
      <div className="space-y-1">
        <Label>Description</Label>
        <Textarea
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          rows={2} placeholder="Optional"
        />
      </div>
      <div className="flex gap-3">
        <Button
          onClick={handleDeploy}
          disabled={loading || !form.modelName.trim()}
          className="gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Deploy
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
      </div>
    </div>
  );
};

// ── Custom Model Form ──────────────────────────────────────────────────────

const CustomModelForm = ({
  onDeploy,
  onCancel,
  loading,
}: {
  onDeploy: (
    yaml: string,
    modelName: string,
    description: string,
    cores: number,
    ptFile: File,
    datasetZip: File,
    datasetName: string,
  ) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}) => {
  const { toast } = useToast();
  const [form, setForm] = useState({
    modelName: "",
    description: "",
    numberOfCores: String(DEFAULT_CORES),
    datasetName: "",
  });
  const [ptFile, setPtFile] = useState<File | null>(null);
  const [datasetZip, setDatasetZip] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parsedClasses, setParsedClasses] = useState<{ nc: number; names: string[] } | null>(null);

  // Parse data.yaml from zip to get nc and names
  const handleZipChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDatasetZip(file);
    setParsedClasses(null);
    setParsing(true);

    try {
      // Read zip and find data.yaml
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(file);
      const dataYamlFile = zip.file(/data\.yaml$/i)?.[0] || zip.file("data.yaml");
      if (!dataYamlFile) {
        toast({ variant: "destructive", title: "data.yaml not found in zip" });
        setParsing(false);
        return;
      }
      const content = await dataYamlFile.async("string");
      // Parse nc and names from YAML
      const ncMatch = content.match(/^nc\s*:\s*(\d+)/m);
      const namesMatch = content.match(/^names\s*:\s*\[([^\]]+)\]/m) ||
                         content.match(/^names\s*:\s*\n((?:\s+-\s+.+\n?)+)/m);
      const nc = ncMatch ? parseInt(ncMatch[1], 10) : 0;
      let names: string[] = [];
      if (namesMatch) {
        if (namesMatch[1].includes("-")) {
          names = namesMatch[1].split("\n")
            .map(l => l.replace(/^\s*-\s*/, "").trim())
            .filter(Boolean);
        } else {
          names = namesMatch[1].split(",").map(n => n.trim().replace(/['"]/g, ""));
        }
      }
      setParsedClasses({ nc: nc || names.length, names });
      toast({ title: `Dataset parsed: ${nc || names.length} classes` });
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to parse zip", description: String(err) });
    } finally {
      setParsing(false);
    }
  };

  const handleDeploy = async () => {
    if (!form.modelName.trim()) {
      toast({ variant: "destructive", title: "Model name required" });
      return;
    }
    if (!ptFile) {
      toast({ variant: "destructive", title: ".pt file required" });
      return;
    }
    if (!datasetZip) {
      toast({ variant: "destructive", title: "Dataset zip required" });
      return;
    }
    if (!parsedClasses) {
      toast({ variant: "destructive", title: "Dataset not parsed yet" });
      return;
    }
    if (!form.datasetName.trim()) {
      toast({ variant: "destructive", title: "Dataset name required" });
      return;
    }

    const name = form.modelName.trim().toLowerCase().replace(/\s+/g, "_");
    const dsName = form.datasetName.trim().toLowerCase().replace(/\s+/g, "_");
    const cores = parseInt(form.numberOfCores, 10) || 1;
    const yaml = generateCustomYaml(
      form.modelName,
      form.description,
      cores,
      dsName,
      parsedClasses.nc,
    );

    await onDeploy(yaml, form.modelName, form.description, cores, ptFile, datasetZip, dsName);
  };

  const [showModelInfo, setShowModelInfo] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Custom Model</h3>
        <button
          type="button"
          onClick={() => setShowModelInfo(v => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
          {showModelInfo ? "Hide requirements" : "Requirements & how it works"}
        </button>
      </div>
      {showModelInfo && (
        <div className="rounded-md border border-blue-200/60 bg-blue-50/40 p-3 text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
          {CUSTOM_MODEL_INFO}
        </div>
      )}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="flex items-center">
              Model name<Req />
            </Label>
            <Input
              value={form.modelName}
              onChange={e => setForm(f => ({ ...f, modelName: e.target.value }))}
              placeholder="e.g. my_detector"
            />
          </div>

          <div className="space-y-1">
            <Label className="flex items-center">
              Cores<Req /><Tip text={CORES_INFO} />
            </Label>
            <Input
              type="number"
              min={1}
              max={2}
              value={form.numberOfCores}
              onChange={e => setForm(f => ({ ...f, numberOfCores: e.target.value }))}
            />
          </div>
        </div>
      <div className="space-y-1">
        <Label>Dataset name<Req /></Label>
        <Input
          value={form.datasetName}
          onChange={e => setForm(f => ({ ...f, datasetName: e.target.value }))}
          placeholder="e.g. my_dataset"
        />
        <p className="text-xs text-muted-foreground">Used as folder name on the device</p>
      </div>
      <div className="space-y-1">
        <Label>Description</Label>
        <Textarea
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          rows={2} placeholder="Optional"
        />
      </div>

      {/* File uploads */}
            <div className="grid grid-cols-2 gap-4 items-start">
        <div className="space-y-1">
          <Label className="flex items-center gap-1">
            Model weights (.pt)<Req />
          </Label>

          <div
            className={`rounded-md border-2 border-dashed p-4 text-center cursor-pointer transition-colors ${
              ptFile
                ? "border-green-500 bg-green-500/5"
                : "border-border hover:border-primary"
            }`}
          >
            <input
              type="file"
              accept=".pt"
              className="hidden"
              id="pt-upload"
              onChange={(e) => setPtFile(e.target.files?.[0] || null)}
            />

            <label htmlFor="pt-upload" className="cursor-pointer">
              {ptFile ? (
                <div className="text-sm">
                  <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto mb-1" />
                  <span className="font-medium text-green-600">
                    {ptFile.name}
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">
                    {(ptFile.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <p>Click to upload .pt file</p>
                  <p className="text-xs mt-1">YOLOv8 weights</p>
                </div>
              )}
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="flex items-center gap-1">
            Calibration dataset (.zip)<Req />
            <Tip text={DATA_YAML_INFO} />
          </Label>

          <div
            className={`rounded-md border-2 border-dashed p-4 text-center cursor-pointer transition-colors ${
              datasetZip
                ? parsedClasses
                  ? "border-green-500 bg-green-500/5"
                  : "border-yellow-500 bg-yellow-500/5"
                : "border-border hover:border-primary"
            }`}
          >
            <input
              type="file"
              accept=".zip"
              className="hidden"
              id="zip-upload"
              onChange={handleZipChange}
            />

            <label htmlFor="zip-upload" className="cursor-pointer">
              {parsing ? (
                <div className="text-sm text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-1" />
                  <p>Parsing data.yaml...</p>
                </div>
              ) : datasetZip ? (
                <div className="text-sm">
                  {parsedClasses ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto mb-1" />
                  ) : (
                    <XCircle className="h-5 w-5 text-yellow-500 mx-auto mb-1" />
                  )}

                  <span className="font-medium">
                    {datasetZip.name}
                  </span>

                  {parsedClasses && (
                    <p className="text-xs text-green-600 mt-1">
                      {parsedClasses.nc} classes detected
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <p>Click to upload YOLO dataset zip</p>
                  <p className="text-xs mt-1">Must contain data.yaml</p>
                </div>
              )}
            </label>
          </div>
        </div>
      </div>
      

      {parsedClasses && parsedClasses.names.length > 0 && (
        <div className="rounded-md bg-muted/50 p-3 text-xs">
          <p className="font-medium mb-1">Detected classes ({parsedClasses.nc}):</p>
          <p className="text-muted-foreground">{parsedClasses.names.slice(0, 10).join(", ")}{parsedClasses.names.length > 10 ? ` +${parsedClasses.names.length - 10} more` : ""}</p>
        </div>
      )}

      <div className="flex gap-3">
        <Button onClick={handleDeploy} disabled={loading || parsing || !parsedClasses} className="gap-2">
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Deploy
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button>
      </div>
    </div>
  );
};

// ── Main Page ──────────────────────────────────────────────────────────────

const ModelsPage = () => {
  const { toast } = useToast();
  const [models, setModels] = useState<Model[]>([]);
  const [progress, setProgress] = useState<Record<string, DeployProgress>>({});
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [modelType, setModelType] = useState<ModelType | null>(null);
  const [confirmSlot, setConfirmSlot] = useState<number | null>(null);
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const startPolling = (deploy_id: string, slot: number, name: string) => {
    if (pollRefs.current[deploy_id]) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/models/deploy-status?deploy_id=${encodeURIComponent(deploy_id)}`);
        if (!res.ok) {
          setProgress(prev => ({ ...prev, [deploy_id]: { ...prev[deploy_id], stage: `retrying (${res.status})...` } }));
          return;
        }
        const data = await res.json();
        const done = data.done;
        const failed = done && data.exit_code !== null && data.exit_code !== 0;

        let errorMsg = "";
        if (failed && data.log) {
          const lines = data.log.split("\n").filter((l: string) => l.includes("ERROR") || l.includes("Failed"));
          errorMsg = lines[lines.length - 1]?.replace(/\u001b\[[0-9;]*m/g, "").trim() || "Deploy failed";
        }

        setProgress(prev => ({
          ...prev,
          [deploy_id]: {
            deploy_id, slot, name,
            progress: data.progress ?? prev[deploy_id]?.progress ?? 0,
            stage: data.stage ?? "running",
            done, failed, errorMsg,
          },
        }));

        if (done) {
          clearInterval(pollRefs.current[deploy_id]);
          delete pollRefs.current[deploy_id];
          loadModels();
          if (!failed) {
            toast({ title: "Model deployed", description: `${name} is ready` });
          } else {
            toast({ variant: "destructive", title: "Deploy failed", description: errorMsg || `${name} failed to deploy` });
          }
        }
      } catch {
        setProgress(prev => ({ ...prev, [deploy_id]: { ...prev[deploy_id], stage: "reconnecting..." } }));
      }
    }, 2000);

    pollRefs.current[deploy_id] = interval;
  };

  const loadModels = async () => {
    try {
      const res = await fetch("/api/models/list");
      if (!res.ok) return;
      const data = await res.json();
      const list: Model[] = data.models || [];
      setModels(list);

      const activeDeployIds = new Set(list.map(m => m.deploy_id).filter(Boolean));
      setProgress(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(id => {
          if (!activeDeployIds.has(id) && next[id].done && next[id].failed) {
            clearInterval(pollRefs.current[id]);
            delete pollRefs.current[id];
            delete next[id];
          }
        });
        return next;
      });

      list.forEach(m => {
        if (!m.deployed && m.deploy_id && !pollRefs.current[m.deploy_id]) {
          startPolling(m.deploy_id, m.slot, m.name);
          setProgress(prev => {
            if (prev[m.deploy_id!]) return prev;
            return { ...prev, [m.deploy_id!]: { deploy_id: m.deploy_id!, slot: m.slot, name: m.name, progress: 0, stage: "resuming...", done: false, failed: false } };
          });
        }
      });
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadModels();
    const interval = setInterval(loadModels, 5000);
    return () => {
      clearInterval(interval);
      Object.values(pollRefs.current).forEach(clearInterval);
    };
  }, []);

  const resetForm = () => {
    setShowForm(false);
    setModelType(null);
  };

  // Deploy default model
  const handleDeployDefault = async (yaml: string, modelName: string, description: string, cores: number) => {
    setLoading(true);
    try {
      const res = await fetch("/api/models/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_name: modelName, description, yaml_content: yaml, number_of_cores: cores }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to add model");
      }
      const data = await res.json();
      setProgress(prev => ({ ...prev, [data.deploy_id]: { deploy_id: data.deploy_id, slot: data.slot, name: modelName, progress: 0, stage: "initializing", done: false, failed: false } }));
      startPolling(data.deploy_id, data.slot, modelName);
      await loadModels();
      toast({ title: "Deploy started", description: `${modelName} deploying at slot ${data.slot}` });
      resetForm();
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to add model" });
    } finally {
      setLoading(false);
    }
  };

  // Deploy custom model — upload files first, then deploy
  const handleDeployCustom = async (
    yaml: string,
    modelName: string,
    description: string,
    cores: number,
    ptFile: File,
    datasetZip: File,
    datasetName: string,
  ) => {
    setLoading(true);
    try {
      const name = modelName.trim().toLowerCase().replace(/\s+/g, "_");

      // 1. Upload .pt file
      const ptForm = new FormData();
      ptForm.append("file", ptFile);
      ptForm.append("model_name", name);
      const ptRes = await fetch("/api/models/upload-weights", { method: "POST", body: ptForm });
      if (!ptRes.ok) {
        const err = await ptRes.json();
        throw new Error(err.detail || "Failed to upload weights");
      }

      // 2. Upload dataset zip
      const dsForm = new FormData();
      dsForm.append("file", datasetZip);
      dsForm.append("dataset_name", datasetName);
      const dsRes = await fetch("/api/models/upload-dataset", { method: "POST", body: dsForm });
      if (!dsRes.ok) {
        const err = await dsRes.json();
        throw new Error(err.detail || "Failed to upload dataset");
      }

      // 3. Deploy with generated YAML
      const res = await fetch("/api/models/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_name: modelName, description, yaml_content: yaml, number_of_cores: cores }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to add model");
      }
      const data = await res.json();
      setProgress(prev => ({ ...prev, [data.deploy_id]: { deploy_id: data.deploy_id, slot: data.slot, name: modelName, progress: 0, stage: "initializing", done: false, failed: false } }));
      startPolling(data.deploy_id, data.slot, modelName);
      await loadModels();
      toast({ title: "Deploy started", description: `${modelName} deploying at slot ${data.slot}` });
      resetForm();
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to add model" });
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (slot: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/models/${slot}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to remove model");
      }
      setProgress(prev => {
        const next = { ...prev };
        Object.entries(next).forEach(([id, p]) => {
          if (p.slot === slot) {
            clearInterval(pollRefs.current[id]);
            delete pollRefs.current[id];
            delete next[id];
          }
        });
        return next;
      });
      await loadModels();
      toast({ title: "Model removed" });
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: err instanceof Error ? err.message : "Failed to remove model" });
    } finally {
      setLoading(false);
      setConfirmSlot(null);
    }
  };

  const inProgressDeployIds = new Set(Object.values(progress).filter(p => !p.done).map(p => p.deploy_id));
  const activeModels = models.filter(m => !m.deploy_id || !inProgressDeployIds.has(m.deploy_id));
  const deployingList = Object.values(progress).filter(p => !p.done);
  const totalSlots = models.length + deployingList.length;

  return (
    <div className="flex flex-col space-y-8">

      {/* Add model panel */}
      <div className="rounded-lg border border-border bg-card p-6">
        {!showForm ? (
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Add Model</h3>
              <p className="text-sm text-muted-foreground">Deploy a model to an inference slot</p>
            </div>
            <Button onClick={() => setShowForm(true)} disabled={totalSlots >= 4 || loading || inProgressDeployIds.size > 0} className="gap-2">
              <Plus className="h-4 w-4" />
              Add Model
            </Button>
          </div>
        ) : !modelType ? (
          /* Model type selection */
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Select Model Type</h3>
              <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setModelType("default")}
                className="flex flex-col items-center gap-3 rounded-lg border-2 border-border hover:border-primary hover:bg-primary/5 p-6 text-center transition-all"
              >
                <Cpu className="h-8 w-8 text-primary" />
                <div>
                  <p className="font-semibold">Default Model</p>
                  <p className="text-xs text-muted-foreground mt-1">YOLOv8n pretrained on COCO. Pick class IDs to detect.</p>
                </div>
              </button>
              <button
                onClick={() => setModelType("custom")}
                className="flex flex-col items-center gap-3 rounded-lg border-2 border-border hover:border-primary hover:bg-primary/5 p-6 text-center transition-all"
              >
                <Wrench className="h-8 w-8 text-primary" />
                <div>
                  <p className="font-semibold">Custom Model</p>
                  <p className="text-xs text-muted-foreground mt-1">Upload your own .pt weights and YOLO dataset zip.</p>
                </div>
              </button>
            </div>
          </div>
        ) : modelType === "default" ? (
          <DefaultModelForm onDeploy={handleDeployDefault} onCancel={resetForm} loading={loading} />
        ) : (
          <CustomModelForm onDeploy={handleDeployCustom} onCancel={resetForm} loading={loading} />
        )}
      </div>

      {/* Deploying */}
      {deployingList.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Deploying</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {deployingList.map(d => (
              <div key={d.deploy_id} className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground">Slot {d.slot}</div>
                    <div className="font-semibold">{d.name}</div>
                  </div>
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs text-muted-foreground">{d.stage}</span>
                    <span className="text-xs font-medium">{Math.round(d.progress ?? 0)}%</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5">
                    <div className="h-1.5 rounded-full transition-all duration-500 bg-primary" style={{ width: `${d.progress ?? 0}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active models */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Active Models</h2>
        {activeModels.length === 0 && deployingList.length === 0 ? (
          <div className="grid h-40 w-full place-items-center rounded-lg border border-dashed border-border bg-card/50">
            <p className="text-sm text-muted-foreground">No models added yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {activeModels.map(model => {
              const p = model.deploy_id ? progress[model.deploy_id] : null;
              const failed = p?.failed ?? false;
              return (
                <div key={model.slot} className={`rounded-lg border bg-card p-4 space-y-3 ${failed ? "border-destructive/50" : "border-border"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground">Model Slot {model.slot}</div>
                      <div className="font-semibold">{model.name}</div>
                    </div>
                    {model.deployed
                      ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                      : failed
                        ? <XCircle className="h-5 w-5 text-destructive" />
                        : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    }
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {model.deployed
                      ? `Inferencing on tile ${model.slot}`
                      : failed
                        ? <span className="text-destructive">{p?.errorMsg || "Deploy failed"}</span>
                        : "Waiting for deploy..."
                    }
                  </div>
                  <Button
                    onClick={() => setConfirmSlot(model.slot)}
                    disabled={loading}
                    variant="destructive"
                    size="sm"
                    className="w-full gap-2"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm remove */}
      {confirmSlot !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
            <h2 className="mb-4 text-lg font-semibold">Remove Model?</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              Remove model at slot {confirmSlot}? The stream will stop.
            </p>
            <div className="flex gap-3">
              <Button onClick={() => setConfirmSlot(null)} variant="outline" className="flex-1" disabled={loading}>Cancel</Button>
              <Button onClick={() => handleRemove(confirmSlot)} variant="destructive" className="flex-1" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelsPage;