# AWS Lambda container image for the audio worker. Build context: worker/.
#
#   cd worker
#   docker build --platform linux/arm64 --secret id=hf_token,env=HF_TOKEN -t auto-ace-worker .
#
# HF_TOKEN (Hugging Face, with the pyannote terms accepted) is a build secret: it is used to
# download the models and is never stored in an image layer.

# 3.12, not the 3.11 of the local venv: the 3.11 image is Amazon Linux 2 (glibc 2.26), too old
# for current torch wheels; 3.12 is Amazon Linux 2023.
FROM public.ecr.aws/lambda/python:3.12

# CPU-only torch first, from PyTorch's own index (the PyPI wheels pull in CUDA).
# Versions match the ones the worker was tested with (see requirements.txt).
RUN pip install --no-cache-dir torch==2.15.0 torchaudio==2.11.1 --index-url https://download.pytorch.org/whl/cpu

# ffmpeg: a static binary from imageio-ffmpeg, so no system package repo is needed
RUN pip install --no-cache-dir imageio-ffmpeg==0.7.0 \
    && ln -s "$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" /usr/local/bin/ffmpeg \
    && ffmpeg -hide_banner -version | head -1

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Models, in their own layer so code changes don't download them again.
# download_models.py only needs audioace/config.py; the rest of the code is copied below.
ENV MODELS_DIR=/opt/models
COPY audioace/__init__.py audioace/config.py ${LAMBDA_TASK_ROOT}/audioace/
COPY scripts/download_models.py ${LAMBDA_TASK_ROOT}/scripts/
RUN --mount=type=secret,id=hf_token,required=true \
    HF_TOKEN="$(cat /run/secrets/hf_token)" python ${LAMBDA_TASK_ROOT}/scripts/download_models.py \
    && rm -rf /root/.cache

COPY audioace/ ${LAMBDA_TASK_ROOT}/audioace/
COPY adapters/ ${LAMBDA_TASK_ROOT}/adapters/
COPY cli/ ${LAMBDA_TASK_ROOT}/cli/

# Lambda's filesystem is read-only except /tmp: point every library cache there.
# Models are read only from MODELS_DIR; HF_HUB_OFFLINE and the pyannote telemetry switch are
# also set by audioace.config.apply_offline_env().
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    MPLCONFIGDIR=/tmp/matplotlib \
    NUMBA_CACHE_DIR=/tmp/numba \
    TORCH_HOME=/tmp/torch \
    MODELSCOPE_CACHE=/tmp/modelscope \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYANNOTE_METRICS_ENABLED=false \
    FFMPEG_BIN=/usr/local/bin/ffmpeg

# Fail the build, not the first invocation, if a model is missing or does not load
RUN cd ${LAMBDA_TASK_ROOT} && python -c "from audioace import models; errors = models.load_errors(); print('models loaded'); assert not errors, errors"

CMD ["adapters.lambda_handler.handler"]
